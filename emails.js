'use strict';

var raven = require('raven');
var Q = require('q');
var rp = require('request-promise');
var gcloud = require('google-cloud')({
    projectId: 'newsai-1166'
});

// Import application specific
var gmail = require('./providers/gmail');
var sendgrid = require('./providers/sendgrid');

// Instantiate a datastore client
var datastore = require('@google-cloud/datastore')({
    projectId: 'newsai-1166'
});

// Initialize Google Cloud
var storage = gcloud.storage();
var storageBucket = 'tabulae-email-attachment';
var pubsub = gcloud.pubsub();
var subscriptionName = 'appengine-flex-service-1'
var topicName = 'tabulae-emails-service'

// Initialize Sentry
var sentryClient = new raven.Client('https://86fa2a75d816431a930f9403613bb8b0:20ffd70440344532ab20fd18c3b998eb@sentry.io/211180');
sentryClient.patchGlobal();

/**
 * Gets a Datastore key from the kind/key pair in the request.
 *
 * @param {Object} requestData Cloud Function request data.
 * @param {string} requestData.Id Datastore ID string.
 * @returns {Object} Datastore key object.
 */
function getKeysFromRequestData(requestData, resouceType) {
    if (!requestData.EmailIds) {
        throw new Error("Id not provided. Make sure you have a 'Id' property " +
            "in your request");
    }

    var ids = requestData.EmailIds;
    var keys = [];

    for (var i = ids.length - 1; i >= 0; i--) {
        var datastoreId = datastore.key([resouceType, ids[i]]);
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
function getDatastore(keys) {
    var deferred = Q.defer();
    try {
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

function getAttachment(attachment) {
    var deferred = Q.defer();
    var fileContents = new Buffer('');
    var bucket = storage.bucket(storageBucket);
    var bucketFile = bucket.file(attachment.data.FileName);
    var stream = bucketFile.createReadStream();

    stream.on('data', function(chunk) {
        fileContents = Buffer.concat([fileContents, chunk]);
    }).on('end', function() {
        bucketFile.get(function(err, fileData, apiResponse) {
            // file.metadata` has been populated.
            var file = {
                name: attachment.data.OriginalName,
                type: fileData.metadata.contentType,
                data: fileContents
            };
            deferred.resolve(file);
        });
    });

    return deferred.promise;
}

function getAttachments(attachments) {
    var allPromises = [];

    for (var i = 0; i < attachments.length; i++) {
        var toExecute = getAttachment(attachments[i]);
        allPromises.push(toExecute);
    }

    return Q.all(allPromises);
}

function getEmails(data, resouceType) {
    var deferred = Q.defer();
    try {
        var keys = getKeysFromRequestData(data, resouceType);
        getDatastore(keys).then(function(emails) {
            // Get user, billing, and files
            var singleEmailData = emails[0].data;
            var userAttachmentKeys = [];

            // Get user
            var userId = datastore.key(['User', singleEmailData.CreatedBy]);
            userAttachmentKeys.push(userId);

            // Get files
            if (singleEmailData.Attachments) {
                for (var i = 0; i < singleEmailData.Attachments.length; i++) {
                    var fileId = datastore.key(['File', singleEmailData.Attachments[i]]);
                    userAttachmentKeys.push(fileId);
                }
            }

            getDatastore(userAttachmentKeys).then(function(userFileEntities) {
                // Get billing
                var user = {};
                var files = [];
                for (var i = 0; i < userFileEntities.length; i++) {
                    if (userFileEntities[i].key.kind === 'User') {
                        user = userFileEntities[i];
                    } else {
                        files.push(userFileEntities[i])
                    }
                }

                if (user.data.BillingId === 0) {
                    var err = 'User Billing Id is missing for user: ' + userId;
                    console.error(err);
                    sentryClient.captureMessage(err);
                    deferred.reject(new Error(err));
                } else {
                    var billingKeys = [];
                    var billingId = datastore.key(['Billing', user.data.BillingId]);
                    billingKeys.push(billingId);

                    getDatastore(billingKeys).then(function(billingEntities) {
                        deferred.resolve({
                            emails: emails,
                            user: user,
                            billing: billingEntities,
                            files: files
                        });
                    }, function(err) {
                        console.error(err);
                        sentryClient.captureMessage(err);
                        deferred.reject(new Error(err));
                    });
                }
            }, function(err) {
                console.error(err);
                sentryClient.captureMessage(err);
                deferred.reject(new Error(err));
            });
        }, function(err) {

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

function sendEmail(email, user, emailMethod, userBilling, attachments) {
    var deferred = Q.defer();

    if (emailMethod === 'gmail') {
        // We already determined that the user has
        // Gmail access through our platform
        // when we set the 'method' of the email
        gmail.setupEmail(sentryClient, user).then(function(newUser) {
            gmail.sendEmail(sentryClient, email, newUser, userBilling, attachments).then(function(response) {
                deferred.resolve(response);
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
    } else if (emailMethod === 'sendgrid') {
        sendgrid.sendEmail(sentryClient, email, user, userBilling, attachments).then(function(response) {
            deferred.resolve(response);
        }, function(err) {
            console.error(err);
            sentryClient.captureMessage(err);
            deferred.reject(err);
        });
    } else if (emailMethod === 'outlook') {

    } else if (emailMethod === 'smtp') {

    } else {
        console.error('No email method present');
        deferred.resolve({});
    }

    return deferred.promise;
}

function sendEmails(emailData, attachments) {
    var deferred = Q.defer();
    var allPromises = [];

    // Setup what we need for all these emails
    var emails = emailData.emails;
    var firstEmail = emails[0];
    var emailMethod = firstEmail.data.Method;

    // Setup promises for each of these emails
    for (var i = 0; i < emails.length; i++) {
        var tempFunction = sendEmail(emails[i], emailData.user, emailMethod, emailData.billing, attachments);
        allPromises.push(tempFunction);
    }

    return Q.all(allPromises);
}

function setupEmails(data) {
    var deferred = Q.defer();

    getEmails(data, 'Email').then(function(emailData) {
        // If couldn't lookup emails or there were no emails to send
        if (emailData.emails.length === 0) {
            deferred.resolve({});
        } else {
            // Get files of the attachment themselves
            getAttachments(emailData.files).then(function(attachments) {
                sendEmails(emailData, attachments).then(function(response) {
                    deferred.resolve(response);
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
// subscribe(function(err, message) {
//     setupEmails(message.data).then(function(status) {
//         rp('https://hchk.io/ccb41d9b-287f-4a8c-af43-8113aa0ccc34').then(function(htmlString) {
//             console.log('Email sent for ' + message.data)
//         }).catch(function(err) {
//             console.error(err);
//         });
//     }, function(err) {
//         console.error(err);
//     });
// });

setupEmails({
    EmailIds: [5194829768163328]
}).then(function(resp) {
    console.log(resp);
}, function(err) {
    console.error(err);
});