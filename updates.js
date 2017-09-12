function sendToUpdateService(updates) {
    var deferred = Q.defer();

    var options = {
        method: 'POST',
        uri: 'https://updates-dot-newsai-1166.appspot.com/updates',
        json: updates
    };

    rp(options)
        .then(function(jsonBody) {
            deferred.resolve(jsonBody);
        })
        .catch(function(err) {
            // If there's problems even getting a new access token
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}
