'use strict';

var Q = require('q');
var common = require('./common');

var smtp = exports;

function sendEmail(sentryClient, email, newUser, userBilling, attachments, emailSetting) {
    var deferred = Q.defer();

    var postURL = 'https://tabulae-smtp.newsai.org/send';
    var emailFormat = common.generateEmail(email, user, attachments);
    var emailFormatString = emailFormat.join('');

    return deferred.promise;
}

smtp.sendEmail = sendEmail;