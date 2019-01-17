"use strict";
require("dotenv").config({ path: ".env" });
var nodemailer = require("nodemailer");
var log4js = require("log4js");
var logger = log4js.getLogger("cronjob");
logger.level = "debug";

var transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PW
  }
});

var mailOptions = {
  from: process.env.MAIL_USER,
  to: process.env.MAIL_TO,
  cc: process.env.MAIL_CC,
  replyTo: process.env.REPLY_TO,
  subject: "FTP DSV log",
  text: ""
};
const configLocal = {
  host: process.env.FTP_DSV_HOST,
  user: process.env.FTP_DSV_USER,
  password: process.env.FTP_DSV_PW
};

const outbox = "/outbox";
var PromiseFtp = require("promise-ftp");
var fs = require("fs");
var path = require("path");

var ftp = new PromiseFtp();

var bluebird = require("bluebird");
var soap = require("strong-soap").soap;

var xmlHandler = new soap.XMLHandler();
const wsdl_capture_url = process.env.Capture;
const captureWsContentType = "application/soap+xml; charset=utf-8";

function createObjectEvent(objectEvent) {
  return `<EPCISBody xmlns="">
	  <EventList>
      ${objectEvent}
  	</EventList>
  </EPCISBody>`;
}
function streamToString(stream, cb) {
  const chunks = [];
  stream.on("data", chunk => {
    chunks.push(chunk.toString());
  });
  stream.on("end", () => {
    cb(chunks.join(""));
  });
}

ftp
  .connect(configLocal)
  .then(function(serverMessage) {
    logger.info("Server message: " + serverMessage);
    return ftp.list(outbox);
  })
  .then(list => {
    var xmlFiles = list.filter(elem => elem.name.endsWith("xml"));
    var gets = xmlFiles.map(l => {
      return () =>
        ftp.get(`${outbox}/${l.name}`).then(stream => {
          return new Promise(function(resolve, reject) {
            stream.once("close", resolve);
            stream.once("error", reject);
            streamToString(stream, resolve);
            stream.pipe(
              fs.createWriteStream(path.join(__dirname, "files", l.name))
            );
            ftp
              .rename(`${outbox}/${l.name}`, `${outbox}/archiv/${l.name}`)
              .then(() => {
                logger.info(
                  `${outbox}/${l.name} nach ${outbox}/archiv/${
                    l.name
                  } verschoben`
                );
              });
          });
        });
    });
    return bluebird.mapSeries(gets, getStep => getStep());
  })
  .catch(err => {
    logger.error(
      "FTP: beim Download von EPCIS-Events von DSV-FTP-Server ist ein Fehler aufgetreten: ",
      err
    );
    mailOptions.text += `FTP: beim Download von EPCIS-Events von DSV-FTP-Server ist ein Fehler aufgetreten\n`;
  })
  .then(data => {
    soap.createClient(wsdl_capture_url, {}, function(err, client) {
      const soapHeader = `<a:Action xmlns:a="http://www.w3.org/2005/08/addressing">http://tempuri.org/ICoreCaptureService/Capture</a:Action>`;

      client.addSoapHeader(soapHeader);
      client.addHttpHeader("Content-Type", captureWsContentType);
      var epcisbody = {
        document: xmlHandler.xmlToJson(
          null,
          createObjectEvent(data.join("\n")),
          null
        )
      };
      client.Capture(epcisbody, function(err, result, envelope) {
        if (err) {
          logger.error(err);
          logger.error("############### LAST REQUEST ##############");
          logger.error(client.lastRequest);
          mailOptions.text += `Fehler beim Capturen der ${
            data.length
          } ObjectEvents nach Zepra\n`;
        } else {
          logger.info(
            `Es wurden ${
              data.length
            } ObjectEvents von DSV nach Zepra übertragen`
          );
          mailOptions.text += `Es wurden ${
            data.length
          } ObjectEvents von DSV nach Zepra übertragen\n`;
        }
        transporter.sendMail(mailOptions, function(error, info) {
          if (error) {
            logger.error("Error while sending Email", error);
          } else {
            logger.info("Email sent: " + info.response);
          }
        });
        ftp.end();
      });
    });
  })
  .catch(err => {
    logger.error(
      "ZEPRA: beim Capture von EPCIS-Events von DSV-FTP-Server ist ein Fehler aufgetreten: ",
      err
    );
  });
