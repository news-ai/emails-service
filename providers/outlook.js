'use strict';

var Q = require('q');
var rp = require('request-promise');
var redis = require('redis');

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

// Instantiate a redis client
var client = redis.createClient();

function refreshAccessToken(user) {
    var deferred = Q.defer();

    // Setup options for GET call
    var options = {
        method: 'POST',
        uri: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        form: {
            'client_id': process.env.OUTLOOKAUTHKEY,
            'client_secret': process.env.OUTLOOKAUTHSECRET,
            'refresh_token': user.data.OutlookRefreshToken,
            'grant_type': 'refresh_token'
        },
        json: true
    };

    rp(options)
        .then(function(jsonBody) {
            // If we got a new access token replace the current
            // user access token and return
            user.data.OutlookAccessToken = jsonBody.AccessToken;
            user.data.OutlookTokenType = jsonBody.TokenType;
            deferred.resolve(user);
        })
        .catch(function(err) {
            // If there's problems even getting a new access token
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

function validateAccessToken(user) {
    var deferred = Q.defer();

    // Setup options for GET call
    var options = {
        uri: 'https://outlook.office.com/api/v2.0/me',
        headers: {
            'Authorization': 'Bearer ' + user.data.OutlookAccessToken,
            'Content-Type': 'application/json'
        },
        json: true
    };

    // Try and see if this access token is valid
    rp(options)
        .then(function(jsonBody) {
            deferred.resolve(user);
        })
        .catch(function(err) {
            // If not then we want to get a new access token
            refreshAccessToken(user).then(function(newUser) {
                deferred.resolve(newUser);
            }, function(err) {
                deferred.reject(err);
            })
        });

    return deferred.promise;
}

function setupEmail(user) {
    var deferred = Q.defer();

    validateAccessToken(user).then(function(newUser) {
        // Now we know that we have at least a single valid access token
        deferred.resolve(newUser);
    }, function(err) {

        deferred.reject(err);
    });

    return deferred.promise;
}


function sendEmail(email, user, userBilling, attachmentIds) {
    var deferred = Q.defer();

    var toEmail = {
        EmailAddress: {
            Address: email.data.To
        }
    };

    var message = {
        Message: {
            Subject: email.data.Subject,
            ToRecipients: [toEmail],
            Body: {
                ContentType: 'HTML',
                Content: email.data.Body
            }
        }
    }

    var redisAttachmentId = [];
    for (var i = 0; i < attachmentIds.length; i++) {
        redisAttachmentId.push('attachment_' + attachmentIds[i]);
    }

    client.mget(redisAttachmentId, function(err, redisAttachments) {
        if (redisAttachments.length > 0) {
            message.Message.Attachments = [];
            for (var i = 0; i < redisAttachments.length; i++) {
                var parsedAttachment = JSON.parse(redisAttachments[i]);
                var formattedContentBytes = Buffer(parsedAttachment.data.data).toString('base64');
                var attachment = {
                    'Name': parsedAttachment.name,
                    '@odata.type': '#Microsoft.OutlookServices.FileAttachment',
                    'ContentBytes': formattedContentBytes
                };
                message.Message.Attachments.push(attachment);
            }
        }

        var options = {
            uri: 'https://outlook.office.com/api/v2.0/me/sendmail',
            method: 'POST',
            json: message,
            headers: {
                'Authorization': 'Bearer ' + user.data.OutlookAccessToken,
                'Content-Type': 'application/json'
            },
        };

        rp(options)
            .then(function(jsonBody) {
                deferred.resolve(jsonBody);
            })
            .catch(function(err) {
                deferred.reject(new Error(err));
            });
    });

    return deferred.promise;
}

var app = Consumer.create({
    region: 'us-east-2',
    queueUrl: 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-outlook.fifo',
    handleMessage: (message, done) => {
        var emailDetails = JSON.parse(message.Body);
        console.log(emailDetails.email.key.id);
        setupEmail(emailDetails.user).then(function(newUser) {
            var attachments = emailDetails.attachments || [];
            sendEmail(emailDetails.email, newUser, emailDetails.userBilling, attachments).then(function(response) {
                // What we want to send back to the sendEmails function
                // so we can send that to updates-service
                var returnEmailResponse = {
                    method: emailDetails.emailMethod,
                    delivered: true,
                    emailid: emailDetails.email.key.id
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