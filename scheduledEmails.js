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

// Instantiate a redis client
var client = redis.createClient();

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
        .filter('Cancel', '=', false);

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
        var emailDate = new Date(emails[i].data.SendAt);
        if (emailDate.getFullYear() > 2000) {
            returnEmails.push(emails[i]);
        }
    }

    return returnEmails;
}

function runScheduledEmails() {
    getScheduledEmails().then(function(emails) {
        var scheduledEmails = filteredEmails(emails);
        console.log(scheduledEmails.length);
    }, function(err) {
        console.error(err);
    });
}

runScheduledEmails();