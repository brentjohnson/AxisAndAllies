/**
 * Set up reverse mapping of (property -> enum instance) for lookup
 */
setupEnumMapping = function (target, propNames){
    for(var instance in target){
        if(!target.hasOwnProperty(instance)) continue;
        for(var i = 0; i < propNames.length; i++){
            var propName = propNames[i];
            target[target[instance][propName]] = target[instance];
        }
    }
    return target;
};

safeDOMEmpty = function(selector){
    var j = $(selector);
    Spark.finalize(j[0]);
    j.empty();
    return j;
};

formToHash = function(selector){
    var values = {};
    $.each($(selector).find("input").serializeArray(), function(i, field) {
        values[field.name] = field.value;
    });
    return values;
};

hasOwnValue = function(obj, val){
    for(var prop in obj){
        if(obj.hasOwnProperty(prop) && obj[prop] === val) return true;
    }
    return false;
};