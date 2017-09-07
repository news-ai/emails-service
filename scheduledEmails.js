'use strict';

var raven = require('raven');
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

function setupScheduledEmails() {
    // Dumbest way: send each email individually
    // Clever way: find the similarly scheduled emails and process them together
}

function sendScheduledEmails(argument) {
    // body...
}

function filteredEmails(emails) {
    var returnEmails = [];
    for (var i = 0; i < emails.length; i++) {
        // Filter based on email
        var toAdd = true;

        // Then we check if it has any SendGrid/Gmail Ids
        if (emails[i].data.SendGridId !== '' || emails[i].data.GmailId !== '') {
            toAdd = false;
        }

        if (toAdd) {
            returnEmails.push(emails[i]);
        }
    }

    return returnEmails;
}

function runScheduledEmails() {
    getScheduledEmails().then(function(emails) {
        console.log(emails);
        // var scheduledEmails = filteredEmails(emails);
        // for (var i = 0; i < scheduledEmails.length; i++) {
        //     console.log(scheduledEmails[i]);
        // }
    }, function(err) {
        console.error(err);
    });
}

runScheduledEmails();