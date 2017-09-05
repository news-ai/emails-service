'use strict';

var Q = require('q');
var rp = require('request-promise');

var outlook = exports;

function refreshAccessToken(sentryClient, user) {
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
            sentryClient.captureMessage(err);
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

function validateAccessToken(sentryClient, user) {
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
            refreshAccessToken(sentryClient, user).then(function(newUser) {
                deferred.resolve(newUser);
            }, function(err) {
                sentryClient.captureMessage(err);
                deferred.reject(err);
            })
        });

    return deferred.promise;
}

function setupEmail(sentryClient, user) {
    var deferred = Q.defer();

    validateAccessToken(sentryClient, user).then(function(newUser) {
        // Now we know that we have at least a single valid access token
        deferred.resolve(newUser);
    }, function(err) {
        sentryClient.captureMessage(err);
        deferred.reject(err);
    });

    return deferred.promise;
}


function sendEmail(sentryClient, email, user, userBilling, attachments) {
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
            },
            Attachments: []
        }
    }

    if (attachments.length > 0) {
        for (var i = 0; i < attachments.length; i++) {
            var formattedContentBytes = attachments[i].data.toString('base64');
            var attachment = {
                'Name': attachments[i].name,
                'OdataType': '#Microsoft.OutlookServices.FileAttachment',
                'ContentBytes': formattedContentBytes
            };
            message.Message.Attachments.push(attachment);
        }
    }

    var options = {
        uri: 'https://outlook.office.com/api/v2.0/me/sendmail',
        method: 'POST',
        json: message
    };

    rp(options)
        .then(function(jsonBody) {
            deferred.resolve(jsonBody);
        })
        .catch(function(err) {
            sentryClient.captureMessage(err);
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

outlook.setupEmail = setupEmail;
outlook.sendEmail = sendEmail;