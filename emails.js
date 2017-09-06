'use strict';

var raven = require('raven');
var Q = require('q');
var rp = require('request-promise');
var redis = require('redis');
var gcloud = require('google-cloud')({
    projectId: 'newsai-1166'
});

// Import application specific
var gmail = require('./providers/gmail');
var sendgrid = require('./providers/sendgrid');
var outlook = require('./providers/outlook');
var smtp = require('./providers/smtp');

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

// Instantiate a redis client
var client = redis.createClient();

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
                deferred.reject(new Error(err));
            }

            // The get operation will not fail for a non-existent entities, it just
            // returns null.
            if (!entities) {
                var error = 'Entity does not exist';
                deferred.reject(new Error(error));
            }

            deferred.resolve(entities);
        });

    } catch (err) {
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
            // file.metadata has been populated.
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

function getSMTPEmailSettings(user) {
    var deferred = Q.defer();

    var emailSettingId = datastore.key(['EmailSetting', user.data.EmailSetting]);
    getDatastore([emailSettingId]).then(function(emailSettings) {
        if (emailSettings.length === 0) {
            var err = 'No email setting id present for the user: ' + user.key;
            deferred.reject(new Error(err));
        }

        deferred.resolve(emailSettings[0]);
    }, function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

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
                        deferred.reject(err);
                    });
                }
            }, function(err) {
                deferred.reject(err);
            });
        }, function(err) {
            deferred.reject(err);
        });
    } catch (err) {
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

    // What we want to send back to the sendEmails function
    // so we can send that to updates-service
    var returnEmailResponse = {
        method: emailMethod,
        delivered: false,

        emailid: email.key.id,
        threadid: '',
        sendid: ''
    };

    if (emailMethod === 'gmail') {
        // We already determined that the user has
        // Gmail access through our platform
        // when we set the 'method' of the email
        gmail.setupEmail(sentryClient, user).then(function(newUser) {
            gmail.sendEmail(sentryClient, email, newUser, userBilling, attachments).then(function(response) {
                returnEmailResponse.sendid = response.id;
                returnEmailResponse.threadid = response.threadId
                returnEmailResponse.delivered = true;
                deferred.resolve(returnEmailResponse);
            }, function(err) {
                deferred.reject(err);
            });
        }, function(err) {
            deferred.reject(err);
        });
    } else if (emailMethod === 'sendgrid') {
        sendgrid.sendEmail(sentryClient, email, user, userBilling, attachments).then(function(response) {
            returnEmailResponse.delivered = true;
            returnEmailResponse.sendid = response.emailId;
            deferred.resolve(returnEmailResponse);
        }, function(err) {
            deferred.reject(err);
        });
    } else if (emailMethod === 'outlook') {
        outlook.setupEmail(sentryClient, user).then(function(newUser) {
            outlook.sendEmail(sentryClient, email, newUser, userBilling, attachments).then(function(response) {
                returnEmailResponse.delivered = true;
                deferred.resolve(returnEmailResponse);
            }, function(err) {
                deferred.reject(err);
            });
        }, function(err) {
            deferred.reject(err);
        });
    } else if (emailMethod === 'smtp') {
        getSMTPEmailSettings(user).then(function(emailSetting) {
            smtp.sendEmail(sentryClient, email, user, userBilling, attachments, emailSetting).then(function(response) {
                returnEmailResponse.delivered = response.status;
                deferred.resolve(returnEmailResponse);
            }, function(err) {
                deferred.reject(err);
            });
        }, function(err) {
            deferred.reject(err);
        });
    } else {
        console.error('No email method present');
        deferred.resolve({});
    }

    return deferred.promise;
}

function sendEmails(emailData, attachments, emailMethod) {
    var deferred = Q.defer();
    var allPromises = [];

    // Setup what we need for all these emails
    var emails = emailData.emails;

    // Setup promises for each of these emails
    for (var i = 0; i < emails.length; i++) {
        var tempFunction = sendEmail(emails[i], emailData.user, emailMethod, emailData.billing, attachments);
        allPromises.push(tempFunction);
    }

    return Q.all(allPromises);
}

function sendEmailsAndSendToUpdateService(emailData, attachments, emailMethod) {
    var deferred = Q.defer();

    sendEmails(emailData, attachments, emailMethod).then(function(responses) {
        sendToUpdateService(responses).then(function(status) {
            deferred.resolve(status);
        }, function(err) {
            deferred.reject(err);
        });
    }, function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

function maximumSentForEmailMethod(emailMethod) {
    if (emailMethod === 'gmail') {
        return 500;
    } else if (emailMethod === 'outlook') {
        return 300;
    } else if (emailMethod === 'smtp') {
        return 300;
    }
    return 1000;
}

function splitEmailsUsingRedis(emailData, attachments, emailMethod, numberSent) {
    var deferred = Q.defer();
    var allPromises = [];
    var dailyMaximum = maximumSentForEmailMethod(emailMethod);
    var redisKey = emailData.user.key.id.toString() + '_' + emailMethod;
    var postSendingAmount = numberSent + emailData.emails.length;
    var sentFromEmailProvider = 0;

    // 3 cases:
    // 1. Send all using Sendgrid since we've already emptied it out
    // 2. Send some using Sendgrid and some using email provider
    // 3. Send all using email provider since we haven't used it yet
    if (numberSent > dailyMaximum) {
        // Send using Sendgrid
        var tempFunction = sendEmailsAndSendToUpdateService(emailData, attachments, 'sendgrid');
        allPromises.push(tempFunction);
    } else if (postSendingAmount > dailyMaximum) {
        // Send using both email provider and sendgrid
    } else {
        // Send purely using email provider
        sentFromEmailProvider = emailData.emails.length;
        var tempFunction = sendEmailsAndSendToUpdateService(emailData, attachments, emailMethod);
        allPromises.push(tempFunction);
    }

    // Update in redis how many emails were sent using that email provider
    var d = new Date();
    var secondsLeft = (24*60*60) - (d.getHours()*60*60) - (d.getMinutes()*60) - d.getSeconds();
    client.set(redisKey, numberSent+sentFromEmailProvider, 'EX', secondsLeft);

    return Q.all(allPromises);
}

function splitEmailsForCorrectProviders(emailData, attachments) {
    var deferred = Q.defer();

    // Setup what we need for all these emails
    var emails = emailData.emails;
    var firstEmail = emails[0];
    var emailMethod = firstEmail.data.Method;

    if (emailMethod === 'sendgrid') {
        // If sendgrid then send the emails directly
        sendEmailsAndSendToUpdateService(emailData, attachments, emailMethod).then(function(status) {
            deferred.resolve(status);
        }, function(err) {
            deferred.reject(err);
        });
    } else {
        // Check redis for how many emails have been sent for that particular emailMethod today
        var redisKey = emailData.user.key.id.toString() + '_' + emailMethod;
        client.get(redisKey, function(err, numberSent) {
            if (!numberSent) {
                numberSent = 0;
            }
            splitEmailsUsingRedis(emailData, attachments, emailMethod, numberSent).then(function(status) {
                deferred.resolve(status);
            }, function(err) {
                deferred.reject(err);
            });
        }
    }

    return deferred.promise;
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
                splitEmailsForCorrectProviders(emailData, attachments).then(function(status) {
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