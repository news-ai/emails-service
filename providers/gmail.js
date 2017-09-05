'use strict';

var Q = require('q');
var rp = require('request-promise');
var common = require('./common');

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
    var deferred = Q.defer();

    var postURL = 'https://www.googleapis.com/gmail/v1/users/me/messages/send';
    if (attachments.length > 0) {
        postURL += '?uploadType=multipart';
    }

    var emailFormat = common.generateEmail(email, user, attachments);
    var emailFormatString = emailFormat.join('');
    var emailToSend = new Buffer(emailFormatString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/\//g, '_');

    var options = {
        url: postURL,
        method: 'POST',
        json: {
            raw: emailToSend
        },
        headers: {
            'Authorization': 'Bearer ' + user.data.AccessToken,
            'Content-Type': 'application/json'
        }
    };

    rp(options)
        .then(function(jsonBody) {
            console.log(jsonBody);
            deferred.resolve(jsonBody);
        })
        .catch(function(err) {
            // If there's problems even getting a new access token
            sentryClient.captureMessage(err);
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

gmail.setupEmail = setupEmail;
gmail.sendEmail = sendEmail;