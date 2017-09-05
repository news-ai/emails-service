'use strict';

var Q = require('q');
var rp = require('request-promise');
var common = require('./common');

var smtp = exports;

function sendEmail(sentryClient, email, user, userBilling, attachments, emailSetting) {
    var deferred = Q.defer();

    var emailFormat = common.generateEmail(email, user, attachments);
    var emailFormatString = emailFormat.join('');

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
            // If there's problems even getting a new access token
            sentryClient.captureMessage(err);
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

smtp.sendEmail = sendEmail;