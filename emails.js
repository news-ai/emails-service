'use strict';

var Q = require('q');
var rp = require('request-promise');
var gcloud = require('google-cloud')({
    projectId: 'newsai-1166'
});

// Instantiate a datastore client
var datastore = require('@google-cloud/datastore')({
    projectId: 'newsai-1166'
});

/**
 * Gets a Datastore key from the kind/key pair in the request.
 *
 * @param {Object} requestData Cloud Function request data.
 * @param {string} requestData.Id Datastore ID string.
 * @returns {Object} Datastore key object.
 */
function getKeysFromRequestData(requestData, resouceType) {
    if (!requestData.Id) {
        throw new Error("Id not provided. Make sure you have a 'Id' property " +
            "in your request");
    }

    var ids = requestData.Id.split(',');
    var keys = [];

    for (var i = ids.length - 1; i >= 0; i--) {
        var contactId = parseInt(ids[i], 10);
        var datastoreId = datastore.key([resouceType, contactId]);
        keys.push(datastoreId);
    }

    return keys;
}

/**
 * Retrieves a record.
 *
 * @example
 * gcloud alpha functions call ds-get --data '{'kind':'gcf-test','key':'foobar'}'
 *
 * @param {Object} context Cloud Function context.
 * @param {Function} context.success Success callback.
 * @param {Function} context.failure Failure callback.
 * @param {Object} data Request data, in this case an object provided by the user.
 * @param {string} data.kind The Datastore kind of the data to retrieve, e.g. 'user'.
 * @param {string} data.key Key at which to retrieve the data, e.g. 5075192766267392.
 */
function getDatastore(data, resouceType) {
    var deferred = Q.defer();
    try {
        var keys = getKeysFromRequestData(data, resouceType);

        datastore.get(keys, function(err, entities) {
            if (err) {
                console.error(err);
                sentryClient.captureMessage(err);
                deferred.reject(new Error(err));
            }

            // The get operation will not fail for a non-existent entities, it just
            // returns null.
            if (!entities) {
                var error = 'Entity does not exist';
                console.error(error);
                sentryClient.captureMessage(error);
                deferred.reject(new Error(error));
            }

            deferred.resolve(entities);
        });

    } catch (err) {
        console.error(err);
        sentryClient.captureMessage(err);
        deferred.reject(new Error(err));
    }

    return deferred.promise;
}

// Get a Google Cloud topic
function getTopic(currentTopicName, cb) {
    pubsub.createTopic(currentTopicName, function(err, topic) {
        // topic already exists.
        if (err && err.code === 409) {
            return cb(null, pubsub.topic(currentTopicName));
        }
        return cb(err, topic);
    });
}

// Subscribe to Pub/Sub for this particular topic
function subscribe(cb) {
    var subscription;

    // Event handlers
    function handleMessage(message) {
        cb(null, message);
    }

    function handleError(err) {
        sentryClient.captureMessage(err);
        console.error(err);
    }

    getTopic(topicName, function(err, topic) {
        if (err) {
            return cb(err);
        }

        topic.subscribe(subscriptionName, {
            autoAck: true,
            reuseExisting: true
        }, function(err, sub) {
            if (err) {
                return cb(err);
            }

            subscription = sub;

            // Listen to and handle message and error events
            subscription.on('message', handleMessage);
            subscription.on('error', handleError);

            console.log('Listening to ' + topicName +
                ' with subscription ' + subscriptionName);
        });
    });

    // Subscription cancellation function
    return function() {
        if (subscription) {
            // Remove event listeners
            subscription.removeListener('message', handleMessage);
            subscription.removeListener('error', handleError);
            subscription = undefined;
        }
    };
}

// Begin subscription
subscribe(function(err, message) {
    
});
