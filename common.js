'use strict';

var raven = require('raven');
var AWS = require('aws-sdk');
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
var common = exports;

// Instantiate a redis client
var client = redis.createClient();

// Initialize Google Cloud
var storage = gcloud.storage();
var storageBucket = 'tabulae-email-attachment';

// AWS setup
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
var sqs = new AWS.SQS({
    region: 'us-east-2'
});

// Initialize Sentry
var sentryClient = new raven.Client('https://bfbe974199d945aca34197c9963af19f:c36b74a9fe7840659d31d01f31a072d6@sentry.io/215725');
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
                _id: attachment.key.id,
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

function getDelayParameterForEmail(emailIndex) {
    var betweenDelay = 60;

    // 150 is the number of emails which we want to introduce
    // the delay after. The delay will come after the first
    // 150 emails the user sends out. It'll be delayed every
    // 60 seconds for a batch of 150 after that.
    var delayAmount = Math.floor(emailIndex / 150);
    return delayAmount * betweenDelay;
}

function sendEmail(email, user, emailMethod, userBilling, attachments, emailDelay) {
    var deferred = Q.defer();

    var msg = {
        email: email,
        user: user,
        emailMethod: emailMethod,
        userBilling: userBilling,
        attachments: attachments,
        emailDelay: emailDelay
    };

    var queueURL = '';
    if (emailMethod === 'gmail') {
        queueURL = 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-gmail.fifo';
    } else if (emailMethod === 'outlook') {
        queueURL = 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-outlook.fifo';
    } else if (emailMethod === 'sendgrid') {
        queueURL = 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-sendgrid.fifo';
    } else if (emailMethod === 'smtp') {
        queueURL = 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-smtp.fifo';
    }

    if (queueURL === '') {
        var err = 'No queue selected';
        console.error(err);
        deferred.resolve(err);
    } else {
        var sqsParams = {
            MessageBody: JSON.stringify(msg),
            QueueUrl: queueURL,
            MessageGroupId: user.key.id.toString(),
            MessageDeduplicationId: email.key.id.toString()
        };

        sqs.sendMessage(sqsParams, function(err, data) {
            if (err) {
                console.error(err);
                deferred.resolve(err);
            } else {
                deferred.resolve(data);
            }
        });
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
        // Set in redis that we are sending each of these emails
        var emailId = emails[i].key.id.toString();
        var redisKey = 'email_' + emailId;
        var redisValue = {
            'id': emailId,
            'status': 'sending',
            'message': ''
        };
        client.set(redisKey, JSON.stringify(redisValue), 'EX', 60 * 60 * 24);

        // Add promise to send email
        var emailDelay = getDelayParameterForEmail(i);
        var tempFunction = sendEmail(emails[i], emailData.user, emailMethod, emailData.billing, attachments, emailDelay);
        allPromises.push(tempFunction);
    }

    return Q.all(allPromises);
}

function sendEmailsAndSendToQueues(emailData, attachments, emailMethod) {
    var deferred = Q.defer();

    // Keep this function as a middleware. If we ever want to log or do some
    // kind of more intelligent routing.
    sendEmails(emailData, attachments, emailMethod).then(function(responses) {
        deferred.resolve(responses);
    }, function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

function maximumSentForEmailMethod(emailMethod) {
    if (emailMethod === 'gmail') {
        return 300;
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

    // Setup functions of what we're going to be using to send out our emails
    var dailyMaximum = maximumSentForEmailMethod(emailMethod);
    var redisKey = emailData.user.key.id.toString() + '_' + emailMethod;
    var postSendingAmount = numberSent + emailData.emails.length;
    var sentFromEmailProvider = 0;

    // 3 cases:
    // 1. Send all using Sendgrid since we've already emptied it out
    // 2. Send some using Sendgrid and some using email provider
    // 3. Send all using email provider since we haven't used it yet
    if (numberSent >= dailyMaximum) {
        // Send using Sendgrid
        // Setup promise to send using Sendgrid
        var tempFunction = sendEmailsAndSendToQueues(emailData, attachments, 'sendgrid');
        allPromises.push(tempFunction);
    } else if (postSendingAmount > dailyMaximum) {
        // Number of emails sent + number of emails going to send is more
        // than what we should be sending today then:
        // Send using both email provider and Sendgrid
        var providerAmountLeft = dailyMaximum - numberSent;

        // These are what we'll use in sending out the 2 email promises
        var emailProviderEmailData = Object.assign({}, emailData);
        var sendgridEmailData = Object.assign({}, emailData);

        emailProviderEmailData.emails = [];
        sendgridEmailData.emails = [];

        // We want to split the emailProviderEmailData.emails array
        // into 2. No duplicates between emailProviderEmailData and
        // sendgridEmailData
        var splitOne = emailData.emails.slice(0, providerAmountLeft);
        var splitTwo = emailData.emails.slice(providerAmountLeft);

        emailProviderEmailData.emails = splitOne;
        sendgridEmailData.emails = splitTwo;

        // Split into 2 arrays: one for email provider, one for sendgrid
        // 1. Send from email provider
        if (emailProviderEmailData.emails.length > 0) {
            // Update the number we're sending from email provider
            sentFromEmailProvider = emailProviderEmailData.emails.length;

            // Setup promise to send using email provider
            var tempFunctionEmailProvider = sendEmailsAndSendToQueues(emailProviderEmailData, attachments, emailMethod);
            allPromises.push(tempFunctionEmailProvider);
        }

        // 2. Send from Sendgrid
        if (sendgridEmailData.emails.length > 0) {
            // Setup promise to send using Sendgrid
            var tempFunctionSendgrid = sendEmailsAndSendToQueues(sendgridEmailData, attachments, 'sendgrid');
            allPromises.push(tempFunctionSendgrid);
        }

        if ((sendgridEmailData.emails.length + emailProviderEmailData.emails.length) !== emailData.emails.length) {
            console.error('Something is wrong with the email slicing math');
        }
    } else {
        // Send purely using email provider
        sentFromEmailProvider = emailData.emails.length;

        // Setup promise to send using email provider
        var tempFunction = sendEmailsAndSendToQueues(emailData, attachments, emailMethod);
        allPromises.push(tempFunction);
    }

    // Update in redis how many emails were sent using that email provider
    // The secondsLeft is the number of seconds left to midnight. We want it to expire
    // every midnight. Just so when it's a new day - they will get a new limit on
    // how many each provider can send emails.
    var d = new Date();
    var secondsLeft = (24 * 60 * 60) - (d.getHours() * 60 * 60) - (d.getMinutes() * 60) - d.getSeconds();
    client.set(redisKey, numberSent + sentFromEmailProvider, 'EX', secondsLeft);

    return Q.all(allPromises);
}

function splitEmailsForCorrectProviders(emailData, attachments) {
    var deferred = Q.defer();

    // Setup what we need for all these emails
    var emails = emailData.emails;
    var firstEmail = emails[0];
    var emailMethod = firstEmail.data.Method;

    // Add attachments to redis
    var redisAttachments = [];
    if (attachments.length > 0) {
        for (var i = 0; i < attachments.length; i++) {
            var attachmentKey = 'attachment_' + attachments[i]._id;
            client.set(attachmentKey, JSON.stringify(attachments[i]), 'EX', 60 * 60 * 24);
            redisAttachments.push(attachments[i]._id);
        }
    }

    // Create redis keys to lookup if emails have been processed or sent in the past
    var redisEmailKeys = [];
    for (var i = 0; i < emails.length; i++) {
        redisEmailKeys.push('email_' + emails[i].key.id);
    }

    // Attempt to get keys from Redis of each of these emails
    client.mget(redisEmailKeys, function(err, redisEmails) {
        // Check if emails have already been processed
        // if they have then remove them from emailData.emails
        var sentEmails = {};
        if (redisEmails.length > 0) {
            for (var i = 0; i < redisEmails.length; i++) {
                if (redisEmails[i] !== null) {
                    var redisEmailData = JSON.parse(redisEmails[i]);
                    sentEmails[redisEmailData.id] = true;
                }
            }
        }

        // Record the emails in redis
        // So we never accidentally double send these emails
        var tempEmails = emailData.emails.slice();;
        emailData.emails = [];
        for (var i = 0; i < tempEmails.length; i++) {
            var emailId = tempEmails[i].key.id.toString();
            var redisKey = 'email_' + emailId;
            var redisValue = {
                'id': emailId,
                'status': 'processing',
                'message': ''
            };
            client.set(redisKey, JSON.stringify(redisValue), 'EX', 60 * 60 * 24);

            // If email has never been sent before then we add it to emailData
            // emails. This is the array of emails that will actually be sent
            // through the sendEmails function.
            if (!(emailId in sentEmails)) {
                emailData.emails.push(tempEmails[i]);
            }
        }

        // Send emails
        // We split it into Sendgrid & other providers.
        // For Sendgrid we don't need to worry about spliting it among
        // different providers. We can send the Sendgrid emails right away
        if (emailMethod === 'sendgrid') {
            // If sendgrid then send the emails directly
            sendEmailsAndSendToQueues(emailData, redisAttachments, emailMethod).then(function(status) {
                deferred.resolve(status);
            }, function(err) {
                deferred.reject(err);
            });
        } else {
            // For other providers we want to check how many of each provider
            // have been sent. We strictly only want to send a particular amount
            // per day. Just so we can obey the laws of our overlord providers.
            // Check redis for how many emails have been sent for that particular emailMethod today
            var redisKey = emailData.user.key.id.toString() + '_' + emailMethod;
            client.get(redisKey, function(err, numberSent) {
                // If there's no key - that means no emails have been sent
                // through this platform.
                if (!numberSent) {
                    numberSent = 0;
                } else {
                    // If there is a key then the value is a string. So parse it.
                    numberSent = parseInt(numberSent);
                }

                // Send emails to get split. We split using the redis data.
                // Then we update redis to note how many emails have been
                // sent already.
                splitEmailsUsingRedis(emailData, redisAttachments, emailMethod, numberSent).then(function(status) {
                    deferred.resolve(status);
                }, function(err) {
                    deferred.reject(err);
                });
            });
        }
    });

    return deferred.promise;
}

common.getAttachments = getAttachments;
common.splitEmailsForCorrectProviders = splitEmailsForCorrectProviders;
common.getDatastore = getDatastore;
common.getKeysFromRequestData = getKeysFromRequestData;