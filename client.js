if (Meteor.isClient) {

    var _board;

    Template.content.game = function(){
        return getGame();
    };

    Template.controlPanel.gameActive = function(){
        return getGame();
    };

    Template.controlPanel.notYourTurn = notYourTurn;

    Template.controlPanel.waitingForReplay = function(){
        return !isReplayOver();
    };
    
    Template.controlPanel.phaseIs = function(phase){
        var game = getGame();
        if(!game) return false;
        return game.phase === Phase[phase];
    };

    Template.controlPanel.army = function(){
        return getArmy();
    };

    Template.controlPanel.unitInfo = function(){
        var game = getGame();
        if(!game || isCombatActive() || game.phase === Phase.DRAFT || game.phase === Phase.DEPLOY) return undefined;
        var unit = getUnit();
        if(!unit) return undefined;
        return getCard(unit);
    };

    Template.message.text = function(){
        var msg = getMessage();
        // msg = "a really long status message just so I can test exactly how this should be rendered in dat dere sidebar";
        if(!msg) return undefined;
        return "=====<br>" + msg + "<br>=====";
    };

    /**
     * Kills the instant replay, rendering all events not yet rendered
     * immediately (but synchronously), in ascending order of creation timestamp (ie: in order)
     */
    Template.controlPanel.events({
        "click .skip-replay": function(){
            $(".skip-replay").remove();

            var data = getReplayData();
            var board = getBoard();
            for(var i = 0; i < data.length; i++){
                var actionId = data[i];
                var timeout = data[actionId];
                if(timeout){
                    clearTimeout(timeout);
                    var action = Actions.findOne(actionId);
                    if(action) renderAction(action, board);
                }
            }
            board.interruptAnimations().drawAll();
            stopReplay();
            defaultMessage();

            return false;
        },
        "click .army-ready": function(){
            var game = getGame();
            var _self = getArmy();
            switch(game.phase){
                case Phase.DRAFT:
                    Meteor.call("draftDone", _self._id, defaultMessage);
                    break;
                case Phase.DEPLOY:
                    var leftover = countUndeployedUnits(_self);
                    if(leftover > 0){
                        message("You have " + leftover + " units left to deploy.");
                        return false;
                    }

                    setCard(undefined);
                    Meteor.call("deployDone", _self._id, defaultMessage);
                    break;
                case Phase.MOVEMENT:
                case Phase.ASSAULT:
                    setUnit(undefined);
                    Meteor.call("endPlayTurn", _self._id, defaultMessage);
                    break;
                default:
                    throw "unhandled phase in button.army-ready";
            }
            return false;
        }
    });

    /**
     * Sets up an instant replay.
     * Queues all actions tied to the game to be run (ordered by round), allowing
     * ROUND_MILLISECONDS seconds per round. Stores an ordered hash [index -> action, action -> timeout]
     * of timeoutIds that is used to stop the replay and instantly render any actions still in the queue
     * (while not repeating actions that have already been rendered)
     */
    function instantReplay(board){
        var maxRound = -1;
        var replayData = {};
        var count = 0;
        Actions.find({ gameId: getGame()._id}, {sort: { timestamp: 1 } }).forEach(function(action){
            var baseRound = Math.floor(action.round);
            if(baseRound > maxRound) maxRound = baseRound;

            // Setup round is not set on a timeout, to avoid flickering of pieces
            if(action.round === 0){
                message("Instant replay: ROUND 0 (setup)");
                renderAction(action, board);
            } else {

                // Instant replay: each round gets N seconds
                replayData[count] = action._id;
                replayData[action._id] = setTimeout(function(){
                    actionReplayDone(action);
                    message("Instant replay: ROUND " + baseRound);
                    renderAction(action, board);
                    //TODO: might be a bug around here with the path callback. Call draw() after a timeout?
                    // return result from action; if res.draw wait duration then call res.draw()
                }, action.round * ROUND_MILLISECONDS);
                count++;
            }
        });

        var lastTimeout = setTimeout(function(){
            getBoard().drawAll();
            stopReplay();
            defaultMessage();
        }, (maxRound + 1) * ROUND_MILLISECONDS);

        replayData[count] = -1;
        replayData[-1] = lastTimeout;
        count++;
        replayData.length = count;
        startReplay(replayData);
    }

    Template.gameList.events({
       'click .new-game-button': displayGameForm,
       'click .game-link': function(){
           return initializeGame(this);
       }
    });
    Template.gameList.userGames = function(){
        return Games.find({
            $or:[
                {"players.allies": Meteor.userId()},
                {"players.axis": Meteor.userId()}
            ]
        });
    };
    Template.gameList.rendered = function(){
        _board = undefined;
        resetSession();
    };

    Template.gameSummary.faction = getFaction;

    Template.game.faction = getFaction;

    Template.game.mapName = function(){
        return Maps.findOne(this.mapId).name;
    };

    Template.board.rendered = function(){
        var game = getGame();
        if(!game) throw "Template.board.render called with no active game";
        var board = getBoard();
        if(board){
            var polyRendered = $("svg polygon").length;
            var polyShould = Maps.findOne(game.mapId).layout.length;

            // If the Meteor re-render has destroyed any of the board, redraw it
            if(polyRendered < polyShould || $(SELECT + " defs").length === 0){
                board.preloadBackgroundImages().drawAll();
            }
            if(!this.rendered){
                instantReplay(board);
                this.rendered = true;
            }
        } else {
            throw "board DNE"
            //setGame(undefined);
//            initializeGame(game);
//            if(!isReplayOver()) return;
//            board = getBoard();
//            Actions.find({ gameId: getGame()._id}, {sort: { timestamp: 1 } }).forEach(function(action){
//                renderAction(action, board);
//            });
//            board.interruptAnimations().drawAll();
        }
    };

    /**
     * These events trigger when a child of the svg is clicked (but not the svg itself)
     * to avoid intercepting right clicks in the margin
     */
    Template.board.events({
        'click svg *': leftClickHandler,
        'contextmenu svg *': rightClickHandler
    });

    /**
     * Handle left- and right- clicks.
     * Return false (to eat the click) on successful action (deploy or undeploy),
     * return true (to allow the click to propegate) on failed/no action.
     * @returns {Boolean}
     */
    function leftClickHandler(e){
        if(getIsMovementActive()) return false;
        var click = H$.Util.relativeCoordsFromClick(KLASS, e);
        switch(getGame().phase){
            case Phase.DRAFT:
                break;
            case Phase.DEPLOY:
                if(notYourTurn()) return false;
                var unit = getMyUnitHere(click);
                if(unit){
                    undeployHere(click); // move to right click once stacking is implemented
                } else {
                    deployHere(click);
                }
                break;
            case Phase.MOVEMENT:
                var unit = getMyUnitHere(click);
                if(unit && !unit.used){
                    toggleUnitSelection(unit);
                } else if(!unit){
                    if(notYourTurn()) return false;
                    moveHere(click);
                }
                break;
            case Phase.ASSAULT:
                var mine = getMyUnitHere(click);
                var enemy = getEnemyUnitHere(click);
                if(mine && !mine.used){
                    toggleUnitSelection(mine);
                } else if(enemy){
                    if(notYourTurn()) return false;
                    assaultHere(click);
                } else if(!mine){
                    if(notYourTurn()) return false;
                    moveHere(click);
                }
                break;
            default:
                throw "can't handle this phase";
        }
        return false;
    }

    function rightClickHandler(e){
        if(getIsMovementActive()) return false;
        var click = H$.Util.relativeCoordsFromClick(KLASS, e);
        switch(getGame().phase){
            case Phase.DRAFT:
                break;
            case Phase.DEPLOY:
                break;
            case Phase.MOVEMENT:
            case Phase.ASSAULT:
                var unit = getEnemyUnitHere(click);
                if(unit && !unit.used){
                    toggleUnitSelection(unit);
                }
                break;
            default:
                throw "can't handle this phase";
        }
        return false;
    }

    /**
     * Selects the given unit. If the unit is already selected,
     * de-selects it.
     */
    function toggleUnitSelection(unit){
        var old = getUnit();
        if(old && old._id === unit._id){
            setUnit(undefined);
        } else {
            setUnit(unit);
        }
    }

    /**
     * Helper method. Clears any highlights that match {colors}.
     * @param colors    a single css color, or an array of colors
     */
    function clearHighlights(colors){
        var check;
        if(colors.length){
            check = function(hex){
                for(var i = 0; i < colors.length; i++){
                    if(hex.getHighlightColor() === colors[i]) return true;
                }
                return false;
            };
        } else if(colors){
            check = function(hex){
                return hex.getHighlightColor() === color;
            };
        } else {
            check = function(){
                return true;
            }
        }

        var board = getBoard();
        board.forEach(function(hex){
            if(check(hex)) hex.clearHighlight().draw();
        });

        // Redraw everything to avoid drawing on top of projectiles.
        // Skip during replay to avoid revealing queued animations.
        if(isReplayOver()) board.drawAll();
    }

    function moveHere(click){
        var unit = getUnit();
        if(!unit || unit.used || getArmy(unit)._id !== getArmy()._id) return false;

        var board = getBoard();
        var end = board.getAt(click);
        if(!allowStacking(unit, end.getLocation(), board) || !canMoveTo(end)){
            return false;
        }
        var army = getArmy();

        setIsMovementActive(true);
        toggleUnitSelection(unit);
        var start = board.get(unit.location);
        var path = start.getPathTo(end);

        var duration = Math.min(MOVE_MILLISECONDS * path.length, MAX_MOVE);
        var move = board.action().get(unit.location).movePayloadAlongPath(
            board.action().get(unit.location).getPathTo(
                board.action().get(end.getLocation())
            ), { duration: duration }
        );
        setTimeout(function(){
            var endPt = path[path.length - 1].getLocation();
            unit.location = [endPt.x(), endPt.y()];
            unit.used = true;
            Units.update(unit._id, {$set: {location: unit.location, used: unit.used} });

            var nLeft = Units.find({_id: {$in: army.unitIds}, used: false }).count();
            setIsMovementActive(false);
            if(nLeft === 0) Meteor.call("endPlayTurn", army._id, defaultMessage);
        }, duration);
        commitAction(move, duration);
        return true;
    }

    function assaultHere(click){
        var unit = getUnit();
        if(!unit || unit.used || getArmy(unit)._id !== getArmy()._id) return false;

        var board = getBoard();
        var end = board.getAt(click);
        if(!canAttack(end)){
            return false;
        }

        var game = getGame();
        var myArmy = getArmy();
        var start = board.get(unit.location);
        var enemy = Units.findOne(end.getPayloadData());
        setDefender(enemy);

        Meteor.call("attack", getGame()._id, unit, enemy, function(err, results){
            if(results.hits > 0){
                var str = "Attack successful!\n";
                str += getCard(enemy).name + " was ";
                if(results.status === UnitStatus.DAMAGED) str += UnitStatus.DISRUPTED + " and ";
                str += results.status + ".";
                // TODO render rolls
                message(str);

                if(results.status !== enemy.pendingStatus){
                    var hl = getHighlightArgsForStatus(results.status, false);
                    var highlight = (new H$.Action()).get(enemy.location).setHighlight(hl[0], hl[1], hl[2]).draw();
                    setTimeout(function(){
                        Actions.insert({gameId: game._id, duration: 0, round: game.round + 0.5 + Math.min(0.4, (results.duration / ROUND_MILLISECONDS)), timestamp: Date.now(), document: highlight.$serialize()});
                    }, results.duration);
                }
            } else if(results.hits === 0) {
                message("Attack failed.");
            }
            toggleUnitSelection(unit);
            var nLeft = Units.find({_id: {$in: myArmy.unitIds}, used: false }).count();
            if(nLeft === 0) Meteor.call("endPlayTurn", army._id, defaultMessage);
        });

        return true;
    }

    Template.board.actions = function(){
        return Actions.find({ gameId: getGame()._id }, {sort: { timestamp: 1 } });
//        if(!this.actionCutoff){
//            console.log(Date.now())
//            this.actionCutoff = Date.now();
//        }
//        return Actions.find({ gameId: getGame()._id, timestamp: {$gt: this.actionCutoff} }, {sort: { timestamp: 1 } });
    };
    Template.board.width = getWidth;
    Template.board.height = getHeight;

    Template.action.created = function(){
        var board = getBoard();
        if(board) renderAction(this.data, board);
    };

    Template.draft.rendered = initializeSpinners;

    Template.draft.availableCards = function(){
        return UnitCards.find({ "faction": getFaction() });
    };

    Template.draft.pointsLeft = function(){
        return this.MAX_POINTS - this.points;
    };

    // Template.deployment.created = defaultMessage;

    Template.deployment.rendered = function(){
        defaultMessage();
        initializeSpinners(this.data);
    };

    Template.deployment.availableCards = function(){
        var cards = this.unitIds.map(function(unitId){
            return getCard(unitId);
        });
        var seen = {};
        return cards.filter(function(card){
            var isNew = !(card.name in seen);
            seen[card.name] = true;
            return isNew;
        });
    };

    Template.deployment.unitsLeft = function(){
        return countUndeployedUnits(this);
    };

    function countUndeployedUnits(army){
        return Units.find({_id: {$in: army.unitIds}, location: null }).count();
    }

    Template.movement.rendered = function(){
        defaultMessage(false);
    };

    Template.movement.unitsLeft = unusedUnits;

    function unusedUnits(){
        var board = getBoard();
        if(board && isReplayOver()){
            return Units.find({_id: {$in: this.unitIds}, used: false}).count();
        }
        return undefined;
    }

    Template.movement.unitStatus = function(){
        highlights(false);
    };

    function highlights(canAttack){
        var board = getBoard();
        if(!board) return;

        var bgs = [UNIT_SELECTED, CAN_MOVE_TO, ENEMY_SELECTED, UNIT_USED];
        if(canAttack){
            bgs = bgs.concat( [CAN_SEE, CAN_ATTACK, CAN_MOVE_TO_AND_SEE] ); //TODO: can't see?
        }
        clearHighlights(bgs);

        Units.find({_id: {$in: getArmy().unitIds}, used: true }).forEach(function(unit){
            board.get(unit.location).setHighlight(UNIT_USED, true).draw();
        });

        // Highlight all statuses. Pending takes precedence over active.
        forEachUnitInGame(getGame()._id, function(unit){
            var hex = board.get(unit.location);
            var used = hex.getHighlightColor() === UNIT_USED;
            var hl;
            if(unit.pendingStatus){
                hl = getHighlightArgsForStatus(unit.pendingStatus, false);
            } else if(unit.status){
                hl = getHighlightArgsForStatus(unit.status, true);
            }
            if(!hl) return;
            if(used) hl[1] += 0.3;
            hex.setHighlight(hl[0], hl[1], hl[2]).draw();
        });

        var active = getUnit();
        if(!active){
            setCanMoveTo(undefined);
            if(canAttack) setCanAttack(undefined);
            return;
        }

        var start = board.get(active.location);
        if(getArmy(active)._id === getArmy()._id){
            start.setHighlight(UNIT_SELECTED).draw();
        } else {
            start.setHighlight(ENEMY_SELECTED).draw();
        }
        var validMoves = start.getMovementRange(getCard(active).speed);

        // Filter list to empty hexes only
        validMoves = validMoves.reduce(function(array, hex){
            if(hex.getPayloadData() === null) array.push(hex);
            return array;
        }, []);
        for(var i = 0; i < validMoves.length; i++){
            validMoves[i].setHighlight(CAN_MOVE_TO).draw();
        }
        setCanMoveTo(validMoves);

        if(canAttack){
            var reachable = [];
            Units.find({_id: {$in: getOpposingArmy(getArmy(active)).unitIds} }).forEach(function(enemy){
                var end = board.get(enemy.location);
                var los = start.getLineOfSightTo(end);
                if(los){
                    var maxRange = maxAttackRange(active, enemy);
                    var dist = start.getDistanceTo(end);
                    if(dist <= maxRange){
                        for(var i = 0; i < los.length; i++){
                            var target = los[i];
                            if(reachable.indexOf(target) !== -1) continue;
                            if(validMoves.indexOf(target) === -1){
                                target.setHighlight(CAN_SEE).draw();
                            } else {
                                target.setHighlight(CAN_MOVE_TO_AND_SEE).draw();
                            }
                        }
                        end.setHighlight(CAN_ATTACK).draw();
                        reachable.push(end);
                    }
                }
            });
            setCanAttack(reachable);
        }

    }

    Template.assault.rendered = function(){
        defaultMessage(false);
    };

    Template.assault.unitsLeft = unusedUnits;

    Template.assault.combat = function(){
        var defender = getDefender();
        if(!defender) return;
        return {attacker: getCard(getUnit()), defender: getCard(getDefender)};
    };

    Template.assault.unitStatus = function(){
        highlights(true);
    };

    Template.unitCard.events({
        'click .unit-card-title': function(e){
            var _self = this;
            var old = $(".unit-card.selected");
            if(old.attr("data-unit") === _self.name){
                focusSpinner();
                return;
            }

            old.slideUp(200);
            $(".unit-card[data-unit='" + _self.name + "']").slideDown(200, function(){
                setCard(_self);
                focusSpinner();
            });

            function focusSpinner(){
                if(getGame().phase === Phase.DRAFT){
                    setTimeout(function(){
                        $(".unit-spinner[data-unit='" + _self.name + "']").trigger("focus");
                    }, 1);
                }
            }
        },
        'blur .unit-spinner': function(e){
            if(getGame().phase === Phase.DRAFT){
                $(".unit-spinner[data-unit='" + this.name + "']").removeClass("selected");
            }
        },
        'focus .unit-spinner': function(e){
            if(getGame().phase === Phase.DRAFT){
                $(".unit-spinner[data-unit='" + this.name + "']").addClass("selected");
            }
        }
    });

    Template.unitCard.rendered = function(){
        var title = $(this.firstNode);
        if(title.hasClass("selected")){

            // This is a slightly hacky way to force the jQuery to execute after the meteor rerender
            setTimeout(function(){
                title.find(".unit-spinner").focus();
            }, 1);
        }
    };

    Template.unitCard.settingUp = function(){
        var game = getGame();
        return game && (game.phase === Phase.DRAFT || game.phase === Phase.DEPLOY);
    };

    Template.unitCard.isSelected = function(){
        var card = getCard();
        if(!card){
            var unit = getUnit();
            if(unit) card = getCard(unit);
        }
        return card && this._id === card._id;
    };

    Template.unitCard.isSelectedSpinner = function(){
        var game = getGame();
        return game && game.phase === Phase.DRAFT && this._id === getCard();
    };

    /* Prettyprint missing attack values as "-" instead of "null" */
    Template.unitCard.attacks = function(target, range){
        return this.attacks[UnitType[target]][range] || "-";
    };

    /* Begin client helper functions */

    function renderAction(action, board){
        board.action(action.document).$exec();
    }

    function createGameFromForm(){
        var input = formToHash(".new-game-form");

        Meteor.call("userLookup", input["opponent"], function(err, opponent){
            if(err) throw(err);
            if(!opponent){
                alert("No one's registered with that email address! Tell your friend at "
                    + input["opponent"] + " to make an account so you can play.");
                return false;
            }

            var name = input["name"],
                allies,
                axis,
                user = Meteor.userId();

            if(user === opponent){
                alert("You can't play with yourself! (At least make two accounts so we can keep track of who's who)");
                return false;
            }

            if(input["faction"] === "Allies"){
                allies = user;
                axis = opponent;
            } else {
                allies = opponent;
                axis = user;
            }

            // TODO: map selection
            var map = Maps.findOne();
            var game = new Game(name, allies, axis, map);
            game._id = Games.insert(game);
            initializeGame(game);
            return true;
        });
    }

    /**
     * Checks that the clicked hexagon obeys deployment and stacking rules,
     * then places the unit and updates all necessary data structures.
     * @param click     [x, y] of the click within the svg coordinate system
     * @returns {boolean}
     */
    function deployHere(click){
        var spinner = $(".unit-card-title.selected .unit-spinner");
        if(spinner.length === 0){
            message("Select a unit.");
            return false;
        }
        if(spinner.val() === "0"){
            message("You're out of those!");
            return false;
        }
        var board = getBoard();
        var hex = board.getAt(click);
        if(!hex) return false;

        var unit = getArmy().findUndeployed(spinner.attr("data-unit"));
        if(movementCostFn(unit, hex) === Infinity){
            message("That unit can't deploy in that terrain.");
            return false;
        }

        var game = getGame();
        var player = Meteor.userId();

        var allowedEast = false;
        var allowedWest = false;
        if(game.players.east === player){
            allowedEast = validDeployment(board, hex, H$.DIRECTION.E);
        } else if(game.players.west === player){
            allowedWest = validDeployment(board, hex, H$.DIRECTION.W);
        } else {
            allowedEast = validDeployment(board, hex, H$.DIRECTION.E);
            allowedWest = validDeployment(board, hex, H$.DIRECTION.W);
        }
        if(!allowedEast && !allowedWest){
            message("You can't deploy there!");
            return false;
        }
        var success = setUnitLocation(unit, hex.getCoords(), board);
        if(!success) return false;

        if(!game.players.east && allowedEast){
            game.players.east = player;
            game.players.west = getOpponent();
            message("You've chosen the Eastern front!");
        } else if(!game.players.west && allowedWest){
            game.players.west = player;
            game.players.east = getOpponent();
            message("You've chosen the Western front!");
        } else {
            defaultMessage(false);
            return true;
        }
        Games.update(game._id, {$set: {players: game.players} });
        return true;
    }

    /**
     * Calculate whather the target hex is a valid deployment for the given side.
     * "Valid" means {DEPLOYMENT_ZONE_WIDTH} hexes from the east/west edge.
     * @param board
     * @param hex
     * @param dir
     * @returns {boolean}
     */
    function validDeployment(board, hex, dir){
        var edge = hex.farthestInDirection(dir);
        var dist = hex.getStraightLineDistanceTo(edge);
        return dist < DEPLOYMENT_ZONE_WIDTH;
    }

    function undeployHere(click){
        var army = getArmy();
        var board = getBoard();
        var hex = board.getAt(click);
        if(!hex) return false;
        var coords = hex.getCoords();
        for(var i = 0; i < army.unitIds.length; i++){
            var unit = Units.findOne(army.unitIds[i]);
            if(arrayEquals(unit.location, coords)){
                setUnitLocation(unit, null, board);
            }
        }
        return true;
    }

    function getMyUnitHere(click){
        return getArmyUnitHere(getArmy(), click);
    }

    function getEnemyUnitHere(click){
        return getArmyUnitHere(getOpposingArmy(), click);
    }

    function getArmyUnitHere(army, click){
        var board = getBoard();
        var hex = board.getAt(click);
        if(!hex) return undefined;
        var coords = hex.getCoords();
        for(var i = 0; i < army.unitIds.length; i++){
            var unit = Units.findOne(army.unitIds[i]);
            if(arrayEquals(unit.location, coords)){
                return unit;
            }
        }
        return undefined;
    }

    function setUnitLocation(unit, coords, board){
        if(coords !== null && !allowStacking(unit, coords, board)){
            message("You can't move units on top of each other.");
            return false;
        }

        var oldLoc = unit.location;
        var action = board.action();
        if(coords === null){
            action.get(oldLoc).setPayload(null);
        } else if(oldLoc){
            action.get(coords).setPayload(board.action().get(oldLoc).popPayload());
        } else {
            action.get(coords).setPayload(unit._id, getCard(unit).sprite);
        }
        action.draw();

        unit.location = coords;
        Units.update(unit._id, {$set: {location: unit.location} });
        commitAction(action);
        return true;
    }

    function allowStacking(unit, coords, board){
        // Eventual TODO: stacking rules.
        if(!coords) return false;
        if(board.get(coords).getPayloadData()) return false;
        return true;
    }

    /**
     * Insert action into database (which will render it in the template).
     */
    function commitAction(action, duration){
        duration = duration || 0;
        var game = getGame();
        var time = Date.now();
        Actions.insert({gameId: game._id, duration: duration, round: game.round, timestamp: time, document: action.$serialize()});
    }

    function displayGameForm(){
        safeDOMEmpty(".content").append(Meteor.render(Template.newGame));
        $(".create-game").on("click", createGameFromForm);
        $("#opponent").on("keypress", function(e){
            if(e.which === 13 /* Enter key */) createGameFromForm();
        });
        return false;
    }

    function initializeGame(game){
        var map = Maps.findOne(game.mapId);
        var mapWidth = (window.innerWidth * (CONTENT_WIDTH - CONTENT_MARGIN));
        var hexSize = (mapWidth / map.width) / Math.sqrt(3);

        // Vertical distance between centers of hexagons
        var hexVert = hexSize * 3 / 2;

        setWidth(mapWidth);
        setHeight(Math.ceil((hexVert * map.height) + (hexSize / 2)));
        setGame(game);

        // Eventual TODO: refactor H$ to allow changing hex size after creation.
        safeDOMEmpty(".content").append(Meteor.render(renderTemplate(Template.game, game)));
        var board = (new H$.HexGrid(getWidth() / 2, getHeight() / 2, hexSize, KLASS)).addMany(map.layout).drawAll();
        setBoard(board);
        var army = getArmy();
        if(!army){
            army = new Army(game, getFaction(game));
            army._id = Armies.insert(army);
        }
        return false;
    }

    function initializeSpinners(army){
        army = army || this.data;
        var spinner = $(".unit-spinner");

        if(getGame().phase === Phase.DRAFT){
            spinner.spinner({
                spin: draftSpin
            }).each(setDraftCount);
        } else {
            spinner.spinner({
                min: 0,
                spin: function(event){
                    event.stopPropagation();
                    return false;
                }
            }).each(setDeployCount);
        }

        function setDraftCount(){
            setCount(this, Phase.DRAFT);
        }

        function setDeployCount(){
            setCount(this, Phase.DEPLOY);
        }

        /**
         * Update the "count" spinner for the current unit.
         * In the DRAFT phase, accounts for all units; in the
         * DEPLOY phase, only counts undeployed (location === null) units.
         */
        function setCount(spinner, phase){
            var unitName = $(spinner).attr("data-unit");
            var count = army.unitIds.reduce(function(count, id){
                var unit = Units.findOne(id);
                if(getCard(unit).name === unitName && (phase === Phase.DRAFT || unit.location === null)) count++;
                return count;
            }, 0);
            $(spinner).attr("value", count);
        }

        function update(){
            Armies.update({ _id: army._id}, {$set: {unitIds: army.unitIds, points: army.points}});
            $(".draft-points-left").text(army.MAX_POINTS - army.points);
        }

        function draftSpin(event, ui){
            event.stopPropagation();
            var next = ui.value;
            var old = this.value || 0;
            var delta = next - old;
            if(next < 0 || delta === 0) return false;

            var unitName = $(this).attr("data-unit");
            if(delta > 0){
                /* attempt to add units */
                var card = UnitCards.findOne({"name": unitName});
                if(army.add(card, delta)){
                    update();
                    $(this).spinner("value", ui.value);
                } /* else insufficient space, do nothing */
            } else {
                var removed = army.remove(unitName, Math.abs(delta));
                if(removed){
                    update();
                    $(this).spinner("value", old - removed);
                }
            }
            return false;
        }
    }

    /* Stubs of server methods */
    Meteor.methods({});

    Meteor.startup(function(){

        // Do something maybe I don't know

    });

}
