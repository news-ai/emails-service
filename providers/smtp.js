'use strict';

var Q = require('q');
var rp = require('request-promise');
var common = require('./common');
var gcloud = require('google-cloud')({
    projectId: 'newsai-1166'
});

// Instantiate a datastore client
var datastore = require('@google-cloud/datastore')({
    projectId: 'newsai-1166'
});

// SQS consumer
var Consumer = require('sqs-consumer');
var AWS = require('aws-sdk');

AWS.config.update({
    region: 'us-east-2',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID_GMAIL,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_GMAIL
});

var sqs = new AWS.SQS({
    region: 'us-east-2'
});

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

function sendEmail(sentryClient, email, user, userBilling, attachments) {
    var deferred = Q.defer();

    var emailFormat = common.generateEmail(email, user, attachments);
    var emailFormatString = emailFormat.join('');

    getSMTPEmailSettings(user).then(function(emailSetting) {
        var SMTPPassword = user.data.SMTPPassword.toString('ascii');
        var emailRequest = {
            servername: emailSetting.data.SMTPServer + ':' + emailSetting.data.SMTPPortSSL,
            emailuser: user.data.SMTPUsername,
            emailpassword: SMTPPassword,
            to: email.data.To,
            subject: email.data.Subject,
            body: emailFormatString
        };

        var options = {
            method: 'POST',
            uri: 'https://tabulae-smtp.newsai.org/send',
            json: emailRequest
        };

        rp(options)
            .then(function(jsonBody) {
                deferred.resolve(jsonBody);
            })
            .catch(function(err) {
                deferred.reject(new Error(err));
            });
    }, function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
}

var app = Consumer.create({
    region: 'us-east-2',
    queueUrl: 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-smtp.fifo',
    handleMessage: (message, done) => {
        var emailDetails = JSON.parse(message.Body);
        console.log(emailDetails.email.key.id);
        var attachments = emailDetails.attachments || [];
        sendEmail(emailDetails.email, emailDetails.user, emailDetails.userBilling, attachments).then(function(response) {
            // What we want to send back to the sendEmails function
            // so we can send that to updates-service
            var returnEmailResponse = {
                method: emailDetails.emailMethod,
                delivered: true,
                sendid: response.emailId
            };

            var sqsParams = {
                MessageBody: JSON.stringify(returnEmailResponse),
                QueueUrl: 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-updates.fifo',
                MessageGroupId: emailDetails.user.key.id.toString(),
                MessageDeduplicationId: emailDetails.email.key.id.toString()
            };

            sqs.sendMessage(sqsParams, function(err, data) {
                if (err) {
                    console.error(err);
                }
                done();
            });
        }, function(err) {
            console.error(err);
            done();
        });
    },
    sqs: sqs
});

app.on('error', (err) => {
    console.error(err.message);
});

app.start();