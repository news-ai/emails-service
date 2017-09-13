'use strict';

var cron = require('cron');
var Q = require('q');
var rp = require('request-promise');

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

// Array for the messages we'll send to the update service
var updateServiceArray = [];

function sendToUpdateService(updates) {
    var deferred = Q.defer();

    var options = {
        method: 'POST',
        uri: 'https://updates-dot-newsai-1166.appspot.com/updates',
        json: updateServiceArray
    };

    console.log(updateServiceArray.length);

    updateServiceArray = [];

    rp(options)
        .then(function(jsonBody) {
            deferred.resolve(jsonBody);
        })
        .catch(function(err) {
            deferred.reject(new Error(err));
        });

    return deferred.promise;
}

var job = cron.job('*/15 * * * * *', function() {
    if (updateServiceArray.length > 0) {
        sendToUpdateService();
    }
});

var app = Consumer.create({
    region: 'us-east-2',
    queueUrl: 'https://sqs.us-east-2.amazonaws.com/859780131339/emails-updates.fifo',
    handleMessage: (message, done) => {
        var updateDetails = JSON.parse(message.Body);
        updateServiceArray.push(updateDetails);
        done();
    },
    sqs: sqs
});

app.on('error', (err) => {
    console.error(err.message);
});

app.start();
job.start();