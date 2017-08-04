'use strict';

const
  request = require('request'),
  express = require('express'), 
  crypto = require('crypto'),
  bodyParser = require('body-parser'),  
  app = express();

const
  app_token = process.env.APP_TOKEN,
  app_secret = process.env.APP_SECRET,
  page_token = process.env.PAGE_TOKEN,
  validation_token = process.env.VALIDATION_TOKEN,
  page_id = process.env.PAGE_ID;  

const 
  graph_api_uri = 'https://graph.facebook.com', 
  messenger_api_uri = `${graph_api_uri}/v2.6/me/messages?access_token=${page_token}`,
  place_api_uri = `${graph_api_uri}/v2.10/search?access_token=${app_token}`,
  userCache = {};

app.use(bodyParser.urlencoded({ 
  extended: false, 
  verify: verifyRequestSignature 
}));
app.use(bodyParser.json());
app.use(express.static(__dirname + '/www'));
app.listen(process.env.PORT || 1337);

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === validation_token) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

app.post('/webhook', (req, res) => {
  let data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(pageEntry => {
      let pageID = pageEntry.id;
      let timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(messagingEvent => {
        if (messagingEvent.message && !messagingEvent.message.isEcho) {          
          handleMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          // handleDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          handlePostback(messagingEvent);
        } else if (messagingEvent.read) {
          // handleMessageRead(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });
  }
  // Assume all went well.
  //
  // You must send back a 200, within 20 seconds, to let us know you've 
  // successfully received the callback. Otherwise, the request will time out.
  res.sendStatus(200);
});

function handleMessage (messagingEvent) { 
  let message_payload = {};
  let user_info = {};
  let ps_user_id = messagingEvent.sender.id;
  let message_text = messagingEvent.message.text;
  let nlp = messagingEvent.message.nlp.entities;

  setTimeout(() => {
    postSenderAction('mark_seen', ps_user_id);    
    setTimeout(() => {
      postSenderAction('typing_on', ps_user_id)
    }, 2000);
  }, 1500);

      
  if (nlp.greetings && nlp.greetings[0].confidence > 0.75) { 
    getUserInfo(ps_user_id, user_info => {
      logUserState(ps_user_id, 'state', 'greetings');
      message_payload = {
        type: 'text',
        payload: {
          text: `Hi, ${user_info.first_name}! I'm the PlacesBot. I can 
          find businesses near you. Wanna get started?`,
          metadata: 'test'
        }
      }
      sendMessage(ps_user_id, 'text', message_payload);    
    })
  } else if (nlp.intent 
                && nlp.intent[0].value == 'affirmative' 
                && nlp.intent[0].confidence > 0.75) {
    //check what they user is affirming
    switch (userCache[ps_user_id].state) {
      case 'greetings': 
        
        message_payload = {
          type: 'quick reply',
          payload: {
            text: `Sweeeeet. Let's start by getting your location.`,
            quick_replies: [
              { "content_type":"location" }
            ]
          }          
        }
        sendMessage(ps_user_id, 'quick reply', message_payload);
        break;
    }
  } else if (messagingEvent.message.attachments) {
    let location = messagingEvent.message.attachments[0].payload.coordinates;
    message_payload = {
      type: 'text',
      payload: {
        text: 'Ok, thanks! How far do you want me to search from where you are?',
        buttons:[
          {
            type: 'postback',
            title: '0.5 miles',
            payload: 0.5
          },
          {
            type: 'postback',
            title: '1 mile',
            payload: 1
          },
          {
            type: 'postback',
            title: '3 miles',
            payload: 3
          },
          {
            type: 'postback',
            title: '5 miles',
            payload: 5
          }
        ]
      }
    }
  }
  
}


function logUserState (ps_user_id, key, value) {
  if (!userCache[ps_user_id]) {
    userCache[ps_user_id] = {};
  }
  userCache[ps_user_id][key] = value;
}

function sendMessage (ps_user_id, type, message_payload) {
  let request_body = {
    recipient: {
      id: ps_user_id
    },
    message:{}
  }

  switch (type) {
    case 'text':
      request_body.message = {
        text: message_payload.payload.text,
        metadata: message_payload.payload.metadata
      }
      break;

    case 'quick reply':
      request_body.message = {
        text: message_payload.payload.text,
        quick_replies: message_payload.payload.quick_replies
      }
      break;
    case 'button template':
      request_body.message = {
        attachment:{
          type:"template",
          payload:{
            template_type:"button",
            text: message_payload.payload.text,
            buttons: message_payload.payload.buttons
          }
        }      
      }
      break;
    default:
      request_body.message.attachment = {       
        type: type,
        payload: message_payload
      }
  }

  request.post(messenger_api_uri, {form: request_body}, (err, res, body) => {
    if (!err && res.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", res.statusCode, res.statusMessage, body.error);
    }
  });
  
}

function handlePostback(messagingEvent) {

}

function postSenderAction (sender_action, ps_user_id, callback) {
  let timeout = 0;
  let request_body = {
    recipient: {
      id: ps_user_id      
    },
    sender_action: sender_action
  }

  request.post(messenger_api_uri, {form: request_body}, (err, res, body) => {
    
    if (err) {
      console.error(err);
    }
  })
}

function getUserInfo (ps_user_id, callback) {
  let user_fields = 'first_name, last_name, timezone, is_payment_enabled';
  let uri = `${graph_api_uri}/v2.6/${ps_user_id}?field=${user_fields}&access_token=${page_token}`;
  
  request.get(uri, (err, res, body) => {
    callback(JSON.parse(body));
  });
}

function getPlaces (location, category, query, callback) {

  let api_uri = `${place_api_uri}?type=place&q=mexican&categories=["FOOD_BEVERAGE"]`

}

function verifyRequestSignature(req, res, buf) {
  let signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    let elements = signature.split('=');
    let method = elements[0];
    let signatureHash = elements[1];

    let expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}