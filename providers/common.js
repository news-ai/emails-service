var Q = require('q');

var common = exports;

function getRedisAttachment(redisClient, attachmentIds) {
    var deferred = Q.defer();

    var redisAttachmentId = [];
    for (var i = 0; i < attachmentIds.length; i++) {
        redisAttachmentId.push('attachment_' + attachmentIds[i]);
    }

    redisClient.mget(redisAttachmentId, function(err, redisAttachments) {
        if (err) {
            deferred.reject(new Error(err));
        } else {
            var attachments = [];
            if (redisAttachments && redisAttachments.length > 0) {
                for (var i = 0; i < redisAttachments.length; i++) {
                    var attachment = JSON.parse(redisAttachments[i]);
                    attachments.push(attachment);
                }
            }
            deferred.resolve(attachments);
        }
    });

    return deferred.promise;
}

function recordRedisError(redisClient, emailDetails, err) {
    var emailId = emailDetails.email.key.id.toString();
    var redisKey = 'email_' + emailId;
    var redisValue = {
        'id': emailId,
        'status': 'error',
        'message': err
    };
    redisClient.set(redisKey, JSON.stringify(redisValue), 'EX', 60 * 60 * 24);
}

function recordRedisSend(redisClient, emailDetails) {
    var emailId = emailDetails.email.key.id.toString();
    var redisKey = 'email_' + emailId;
    var redisValue = {
        'id': emailId,
        'status': 'delivered',
        'message': ''
    };
    redisClient.set(redisKey, JSON.stringify(redisValue), 'EX', 60 * 60 * 24);
}

function generateEmail(email, user, attachments) {
    var nl = "\r\n";
    var boundary = '__newsai_tabulae__';

    var userFullName = [user.data.FirstName, user.data.LastName].join(' ');
    var emailFullName = [email.data.FirstName, email.data.LastName].join(' ');

    var fromEmail = userFullName + '<' + user.data.Email + '>';
    if (user.data.EmailAlias !== '') {
        fromEmail = userFullName + '<' + user.data.EmailAlias + '>';
    }

    var CC = [];
    var BCC = [];

    if (email && email.data && email.data.CC && email.data.CC.length > 0) {
        CC = "Cc: " + email.data.CC.join(',') + nl;
    }

    if (email && email.data && email.data.BCC && email.data.BCC.length > 0) {
        BCC = "Bcc: " + email.data.BCC.join(',') + nl;
    }

    // No attachments
    if (attachments.length === 0) {
        emailFormat = ["From: ", fromEmail, nl,
            CC,
            BCC,
            "reply-to: ", fromEmail, nl,
            "Content-type: text/html;charset=iso-8859-1", nl,
            "MIME-Version: 1.0", nl,
            "To: ", email.data.To, nl,
            "Subject: ", email.data.Subject, nl,
            nl, email.data.Body
        ];
    } else {
        emailFormat = ["MIME-Version: 1.0", nl,
            "To: ", email.data.To, nl,
            CC,
            BCC,
            "From: ", fromEmail, nl,
            "reply-to: ", fromEmail, nl,
            "Subject: ", email.data.Subject, nl,

            "Content-Type: multipart/mixed; boundary=\"", boundary, "\"", nl, nl,

            // Boundary one is email itself
            "--", boundary, nl,

            "Content-Type: text/html; charset=UTF-8", nl,
            "MIME-Version: 1.0", nl,
            "Content-Transfer-Encoding: base64", nl, nl,

            // Body itself
            email.data.Body, nl, nl
        ];

        for (var i = 0; i < attachments.length; i++) {
            if (attachments[i] !== null) {
                var formattedData = Buffer(attachments[i].data.data).toString('base64');
                var attachment = [
                    "--", boundary, nl,
                    "Content-Type: ", attachments[i].type, nl,
                    "MIME-Version: 1.0", nl,
                    "Content-Disposition: attachment; filename=\"", attachments[i].name, "\"", nl,
                    "Content-Transfer-Encoding: base64" + nl, nl,
                    formattedData, nl, nl
                ];

                emailFormat = emailFormat.concat(attachment);
            }
        }

        var finalBoundary = '--' + boundary + '--'
        emailFormat.push(finalBoundary);
    }

    return emailFormat;
}

common.generateEmail = generateEmail;
common.recordRedisError = recordRedisError;
common.recordRedisSend = recordRedisSend;
common.getRedisAttachment = getRedisAttachment;