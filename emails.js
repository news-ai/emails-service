'use strict';

var raven = require('raven');
var Q = require('q');
var rp = require('request-promise');
var redis = require('redis');
var gcloud = require('google-cloud')({
    projectId: 'newsai-1166'
});

// Instantiate a datastore client
var datastore = require('@google-cloud/datastore')({
    projectId: 'newsai-1166'
});

// Initialize Google Cloud
var storage = gcloud.storage();
var storageBucket = 'tabulae-email-attachment';
var pubsub = gcloud.pubsub();
var subscriptionName = 'appengine-flex-service-1';
var topicName = 'tabulae-emails-service';

// Import application specific
var common = require('./common');

// Initialize Sentry
var sentryClient = new raven.Client('https://bfbe974199d945aca34197c9963af19f:c36b74a9fe7840659d31d01f31a072d6@sentry.io/215725');
sentryClient.patchGlobal();

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

function setupEmails(data) {
    var deferred = Q.defer();

    common.getEmails(data, 'Email').then(function(emailData) {
        // If couldn't lookup emails or there were no emails to send
        if (emailData.emails.length === 0) {
            deferred.resolve({});
        } else {
            // Get files of the attachment themselves
            common.getAttachments(emailData.files).then(function(attachments) {
                common.splitEmailsForCorrectProviders(emailData, attachments).then(function(status) {
                    deferred.resolve(status);
                }, function(err) {
                    console.error(err);
                    sentryClient.captureMessage(err);
                    deferred.reject(err);
                });
            }, function(err) {
                console.error(err);
                sentryClient.captureMessage(err);
                deferred.reject(err);
            });
        }
    }, function(err) {
        console.error(err);
        sentryClient.captureMessage(err);
        deferred.reject(err);
    });

    return deferred.promise;
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
    setupEmails(message.data).then(function(status) {
        rp('https://hchk.io/ccb41d9b-287f-4a8c-af43-8113aa0ccc34').then(function(htmlString) {
            console.log('Email sent for ' + message.data.EmailIds);
        }).catch(function(err) {
            console.error(err);
        });
    }, function(err) {
        console.error(err);
    });
});