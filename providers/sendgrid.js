'use strict';

const sgMail = require('@sendgrid/mail');
var Q = require('q');
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

var common = require('./common');

function getSendGridApiKey(userBilling) {
    if (userBilling && userBilling.length > 0 && userBilling[0].data && userBilling[0].data.IsOnTrial) {
        return process.env.SENDGRID_TRAIL;
    }
    return process.env.SENDGRID_PROD;
}

function sendEmail(email, user, userBilling, attachmentIds, emailDelay) {
    var deferred = Q.defer();

    var sendgridApiKey = getSendGridApiKey(userBilling);
    sgMail.setApiKey(sendgridApiKey);

    var userFullName = [user.data.FirstName, user.data.LastName].join(' ');
    var emailFullName = [email.data.FirstName, email.data.LastName].join(' ');

    var fromEmail = userFullName + '<' + user.data.Email + '>';
    if (user.data.EmailAlias !== '') {
        fromEmail = userFullName + '<' + user.data.EmailAlias + '>';
    }

    var toEmail = emailFullName + '<' + email.data.To + '>';

    if (email.data.Subject === '') {
        email.data.Subject = '(no subject)';
    }

    var message = {
        to: toEmail,
        from: fromEmail,
        subject: email.data.Subject,
        html: email.data.Body
    };

    if (email.data && email.data.CC && email.data.CC.length > 0) {
        message.cc = email.data.CC;
    }

    if (email.data && email.data.BCC && email.data.BCC.length > 0) {
        message.bcc = email.data.BCC;
    }

    common.getRedisAttachment(client, attachmentIds).then(function(attachments) {
        if (attachments && attachments.length > 0) {
            message.attachments = [];
            for (var i = 0; i < attachments.length; i++) {
                var formattedContent = Buffer(attachments[i].data.data).toString('base64');
                var attachment = {
                    content: formattedContent,
                    filename: attachments[i].name,
                    type: attachments[i].type,
                    disposition: 'attachment'
                };
                message.attachments.push(attachment);
            }
        }

        // Add email delay. Based on how many emails are sent we delay the
        // messages so it's not overwhelming for the email servers.
        if (emailDelay > 0) {
            var timeSend = new Date();
            timeSend.setSeconds(timeSend.getSeconds() + emailDelay);
            message.sendAt = Math.floor(timeSend / 1000);
        }

        message.custom_args = {
            customerAccountNumber: user.key.id.toString(),
            emailId: email.key.id.toString()
        };

        sgMail.send(message).then(function(response) {
            var emailIdObject = {
                emailId: response[0].headers['x-message-id']
            }
            deferred.resolve(emailIdObject);
        }).catch(function(err) {
            deferred.reject(err);
        });
    });

    return deferred.promise;
}

var app = Consumer.create({
    region: 'us-east-2',
    queueUrl: 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-sendgrid.fifo',
    batchSize: 10,
    handleMessage: (message, done) => {
        var emailDetails = JSON.parse(message.Body);
        console.log(emailDetails.email.key.id);
        var attachments = emailDetails.attachments || [];
        sendEmail(emailDetails.email, emailDetails.user, emailDetails.userBilling, attachments, emailDetails.emailDelay).then(function(response) {
            // What we want to send back to the sendEmails function
            // so we can send that to updates-service
            var returnEmailResponse = {
                method: emailDetails.emailMethod,
                delivered: true,
                sendid: response.emailId,
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
                    common.recordRedisError(client, emailDetails, err);
                    console.error(err);
                } else {
                    common.recordRedisSend(client, emailDetails);
                }
                done();
            });
        }, function(err) {
            common.recordRedisError(client, emailDetails, err);
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