'use strict';

var raven = require('raven');
var cron = require('cron');
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

// Instantiate a redis client
var client = redis.createClient();

// Import application specific
var common = require('./common');

// Initialize Sentry
var sentryClient = new raven.Client('https://86fa2a75d816431a930f9403613bb8b0:20ffd70440344532ab20fd18c3b998eb@sentry.io/211180');
sentryClient.patchGlobal();

function getScheduledEmails() {
    var deferred = Q.defer();

    // We only want emails that are scheduled (so SendAt can't be non-zero)
    // Variable we use to check if SendAt <= timeNow
    var timeNow = new Date();
    timeNow.setSeconds(0);
    timeNow.setMilliseconds(0);

    // Variable we use to get values that are above zero
    var nonZeroTime = new Date();
    nonZeroTime.setFullYear(2015);

    var query = datastore.createQuery('Email')
        .filter('SendAt', '>=', nonZeroTime)
        .filter('SendAt', '<=', timeNow)
        .filter('IsSent', '=', true)
        .filter('Delievered', '=', false)
        .filter('Cancel', '=', false)
        .select('__key__');

    datastore.runQuery(query, (err, entities, nextQuery) => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve(entities);
        }
    });

    return deferred.promise;
}

function filteredEmails(emailData) {
    var returnEmails = [];
    for (var i = 0; i < emailData.emails.length; i++) {
        // Filter based on email
        var toAdd = true;

        // Then we check if it has any SendGrid/Gmail Ids
        if (emailData.emails[i].data.SendGridId !== '' || emailData.emails[i].data.GmailId !== '') {
            toAdd = false;
        }

        if (toAdd) {
            returnEmails.push(emailData.emails[i]);
        }
    }

    return returnEmails;
}

function processEmails(emails) {
    // body...
}

function runScheduledEmails() {
    var deferred = Q.defer();

    getScheduledEmails().then(function(emails) {
        var data = {
            EmailIds: []
        };

        for (var i = 0; i < emails.length; i++) {
            data.EmailIds.push(emails[i].key.id);
        }

        /// Get all emails that were in the email ids array
        common.getEmails(data, 'Email').then(function(emailData) {
            if (emailData.emails.length === 0) {
                deferred.resolve({});
            } else {
                common.getAttachments(emailData.files).then(function(attachments) {
                    var scheduledEmails = filteredEmails(emailData);
                    var scheduledEmailsRedisKey = [];
                    for (var i = 0; i < scheduledEmails.length; i++) {
                        scheduledEmailsRedisKey.push('scheduled_' + scheduledEmails[i].key.id);
                    }
                    // Use redis to double check if the email has been
                    // sent or not. Have a separate redis key for
                    // scheduled emails.
                    client.mget(scheduledEmailsRedisKey, function(err, redisEmails) {
                        // Check if scheduled emails has been sent
                        var scheduledEmails = {};
                        if (redisEmails.length > 0) {
                            for (var i = 0; i < redisEmails.length; i++) {
                                if (redisEmails[i] !== null) {
                                    var redisEmailData = JSON.parse(redisEmails[i]);
                                    scheduledEmails[redisEmailData.id] = true;
                                }
                            }
                        }

                        // Add schedule emails to redis

                        // Send emails
                        // common.splitEmailsForCorrectProviders(emailData, attachments).then(function(status) {
                        //     deferred.resolve(status);
                        // }, function(err) {
                        //     console.error(err);
                        //     sentryClient.captureMessage(err);
                        //     deferred.reject(err);
                        // });
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
    }, function(err) {
        console.error(err);
    });

    return deferred.promise;
}

var cronJob = cron.job("*/60 * * * * *", function() {
    console.log('Running scheduled email');
    runScheduledEmails().then(function(status) {
        console.log(status);
    }, function(err) {
        console.error(err);
    });
});

cronJob.start();