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

function checkEmailNotSent(email) {
    if (email.data.Delievered) {
        return false;
    }

    if (email.data.GmailId === '' && email.data.SendGridId === '') {
        return true;
    }

    return false;
}

function getEmails(emailData) {
    var deferred = Q.defer();

    try {
        var keys = common.getKeysFromRequestData(emailData, 'Email');
        // Get emails
        common.getDatastore(keys).then(function(datastoreEmails) {
            // Lets filter out the emails that are incorrect here. Just so
            // as we're going along we don't consider them. Incorrect
            // emails are just emails that shouldn't be included in the
            // scheduled query.
            var filteredEmails = [];
            for (var i = 0; i < datastoreEmails.length; i++) {
                if (checkEmailNotSent(datastoreEmails[i])) {
                    filteredEmails.push(datastoreEmails[i]);
                }
            }

            if (filteredEmails.length > 0) {
                // Get users
                var userIds = {};
                var fileIds = {};

                // Generate IDs for datastore lookup
                for (var i = 0; i < filteredEmails.length; i++) {
                    // Set user id in hash map
                    userIds[filteredEmails[i].data.CreatedBy] = true;

                    // Set attachment id in hashmap for this email
                    if (filteredEmails[i].data && filteredEmails[i].data.Attachments && filteredEmails[i].data.Attachments.length > 0) {
                        for (var x = 0; x < filteredEmails[i].data.Attachments.length; x++) {
                            fileIds[filteredEmails[i].data.Attachments[x]] = true;
                        }
                    }
                }

                var userIdKeys = Object.keys(userIds);
                var fileIdKeys = Object.keys(fileIds);

                // Go through user and file ids to generate
                // datastore Ids. This is how we will bulk query the users
                // and files we need to send out these emails.
                var userAttachmentKeys = [];
                for (var i = 0; i < userIdKeys.length; i++) {
                    var userId = datastore.key(['User', parseInt(userIdKeys[i])]);
                    userAttachmentKeys.push(userId);
                }

                for (var i = 0; i < fileIdKeys.length; i++) {
                    var fileId = datastore.key(['File', parseInt(fileIdKeys[i])]);
                    userAttachmentKeys.push(fileId);
                }

                common.getDatastore(userAttachmentKeys).then(function(userFileEntities) {
                    var userIdToUser = {};
                    var fileIdToFile = {};

                    for (var i = 0; i < userFileEntities.length; i++) {
                        if (userFileEntities[i].key.kind === 'User') {
                            userIdToUser[userFileEntities[i].key.id] = userFileEntities[i];
                        } else {
                            fileIdToFile[userFileEntities[i].key.id] = userFileEntities[i];
                        }
                    }

                    var emailData = [];
                    var userBillingIds = {};
                    for (var i = 0; i < filteredEmails.length; i++) {
                        var createdBy = filteredEmails[i].data.CreatedBy;
                        var emailUser = userIdToUser[createdBy];
                        var emailFiles = [];

                        if (filteredEmails[i].data && filteredEmails[i].data.Attachments && filteredEmails[i].data.Attachments.length > 0) {
                            for (var x = 0; i < filteredEmails[i].data.Attachments.length; x++) {
                                var attachmentId = filteredEmails[i].data.Attachments[x];
                                var emailFile = fileIdToFile[attachmentId];
                                emailFiles.push(emailFile);
                            }
                        }

                        if (emailUser && emailUser.data && emailUser.data.BillingId) {
                            userBillingIds[emailUser.data.BillingId] = true;
                        }

                        emailData.push({
                            emails: filteredEmails[i],
                            user: emailUser,
                            billing: {},
                            files: emailFiles
                        });
                    }

                    var userBillingIdKeys = Object.keys(userBillingIds);
                    var billingKeys = [];

                    for (var i = 0; i < userBillingIdKeys.length; i++) {
                        var billingId = datastore.key(['Billing', parseInt(userBillingIdKeys[i])]);
                        billingKeys.push(billingId);
                    }

                    common.getDatastore(billingKeys).then(function(billingEntities) {
                        var billingIdToBilling = {};
                        for (var i = 0; i < billingEntities.length; i++) {
                            billingIdToBilling[billingEntities[i].key.id] = billingEntities[i];
                        }

                        for (var i = 0; i < emailData.length; i++) {
                            var userBillingId = emailData[i].user && emailData[i].user.data && emailData[i].user.data.BillingId;
                            emailData[i].billing = billingIdToBilling[userBillingId];
                        }

                        deferred.resolve(emailData);
                    }, function(err) {
                        deferred.reject(err);
                    });
                }, function(err) {
                    deferred.reject(err);
                });
            } else {
                deferred.resolve([]);
            }
        }, function(err) {
            deferred.reject(err);
        });
    } catch (err) {
        deferred.reject(new Error(err));
    }

    return deferred.promise;
}

function getAttachmentsAndSendEmail(emailData) {
    var deferred = Q.defer();

    common.getAttachments(emailData[i].files).then(function(attachments) {
        deferred.resolve(attachments);
    }, function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

function getAttachmentsAndSendEmails(emailData) {
    var allPromises = [];

    for (var i = 0; i < emailData.length; i++) {
        var toExecute = getAttachmentsAndSendEmail(emailData[i]);
        allPromises.push(toExecute);
    }

    return Q.all(allPromises);
}

function runScheduledEmails() {
    var deferred = Q.defer();

    getScheduledEmails().then(function(emails) {
        if (emails.length > 0) {
            var data = {
                EmailIds: []
            };

            for (var i = 0; i < emails.length; i++) {
                data.EmailIds.push(emails[i].key.id);
            }

            // Get all emails that were in the email ids array
            getEmails(data, 'Email').then(function(emailData) {
                if (emailData.length === 0) {
                    console.log('No emails to send');
                    deferred.resolve({});
                } else {
                    getAttachmentsAndSendEmails(emailData).then(function(status) {
                        deferred.resolve(status);
                    }, function(err) {
                        console.error(err);
                        sentryClient.captureMessage(err);
                        deferred.reject(err);
                    })
                }
            }, function(err) {
                console.error(err);
                sentryClient.captureMessage(err);
                deferred.reject(err);
            });
        } else {
            deferred.resolve({});
        }
    }, function(err) {
        console.error(err);
    });

    return deferred.promise;
}

// var cronJob = cron.job("*/60 * * * * *", function() {
//     console.log('Running scheduled email');
//     runScheduledEmails().then(function(status) {
//         console.log(status);
//     }, function(err) {
//         console.error(err);
//     });
// });

// cronJob.start();

runScheduledEmails().then(function(status) {
    console.log(status);
}, function(err) {
    console.error(err);
});