'use strict';

const sgMail = require('@sendgrid/mail');
var Q = require('q');

var sendgrid = exports;

function getSendGridApiKey(userBilling) {
    if (userBilling && userBilling.length > 0 && userBilling[0].data && userBilling[0].data.IsOnTrial) {
        return process.env.SENDGRID_TRAIL;
    }
    return process.env.SENDGRID_PROD;
}

function sendEmail(sentryClient, email, user, userBilling, attachments) {
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

    if (attachments.length > 0) {
        message.attachments = [];
        for (var i = 0; i < attachments.length; i++) {
            var formattedContent = attachments[i].data.toString('base64');
            var attachment = {
                content: formattedContent,
                filename: attachments[i].name,
                type: attachments[i].type,
                disposition: 'attachment'
            };
            message.attachments.push(attachment);
        }
    }

    // Add email delay portion here

    sgMail.send(message).then(function(response) {
        var emailIdObject = {
            emailId: response[0].headers['x-message-id']
        }
        deferred.resolve(emailIdObject);
    }).catch(function(err) {
        sentryClient.captureMessage(err);
        deferred.reject(new Error(err));
    });

    return deferred.promise;
}

sendgrid.sendEmail = sendEmail;