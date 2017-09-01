'use strict';

var Q = require('q');
var rp = require('request-promise');

var gmail = exports;

function refreshAccessToken(sentryClient, user) {
    var deferred = Q.defer();

    // Setup options for GET call
    var options = {
        method: 'POST',
        uri: 'https://www.googleapis.com/oauth2/v4/token',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        form: {
            'client_id': process.env.GOOGLEAUTHKEY,
            'client_secret': process.env.GOOGLEAUTHSECRET,
            'refresh_token': user.data.RefreshToken,
            'grant_type': 'refresh_token'
        },
        json: true
    };

    rp(options)
        .then(function(jsonBody) {
            // If we got a new access token replace the current
            // user access token and return
            user.data.AccessToken = jsonBody.access_token;
            user.data.TokenType = jsonBody.token_type;
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
        uri: 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json&access_token=' + user.data.AccessToken,
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
    var userFullName = [user.data.FirstName, user.data.LastName].join(' ');
    var emailFullName = [email.data.FirstName, email.data.LastName].join(' ');

    var fromEmail = userFullName + '<' + user.data.Email + '>';
    if (user.data.EmailAlias !== '') {
        fromEmail = userFullName + '<' + user.data.EmailAlias + '>';
    }

    var nl = "\r\n";
    var boundary = '__newsai_tabulae__';

    var CC = [];
    var BCC = [];

    if (email && email.data && email.data.CC && email.data.CC.length > 0) {
        CC = "Cc: " + email.data.CC.join(',') + nl;
    }

    if (email && email.data && email.data.BCC && email.data.BCC.length > 0) {
        BCC = "Bcc: " + email.data.BCC.join(',') + nl;
    }

    var emailFormat = [];

    // No attachments
    if (attachments.length === 0) {
        emailFormat = ["MIME-Version: 1.0", nl,
            "To: ", to, nl,
            CC,
            BCC,
            "From: ", fromEmail, ml,
            "reply-to: ", fromEmail, nl,
            "Subject: ", email.data.Subject, nl,
            message
        ];
    }
    // Attachments
}

gmail.setupEmail = setupEmail;
gmail.sendEmail = sendEmail;