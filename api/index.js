const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const deepai = require('deepai');
const { generateAsync } = require('stability-client');
const imageToSlices = require('image-to-slices');
const uuid4 = require('uuid4');

const MESSAGE_TOKEN = process.env.MESSAGE_TOKEN;
const STABILITY_KEY = process.env.STABILITY_KEY;
const DEEP_AI_KEY = process.env.DEEP_AI_KEY;
const TELEGRAM_API_TOKEN = process.env.TELEGRAM_API_TOKEN;
const TELEGRAM_SECRET_KEY = process.env.TELEGRAM_SECRET_KEY;
const PREFFER_DEEPAI = process.env.PREFFER_DEEPAI;
const DEEPAI_SPLIT_IMAGES = process.env.DEEPAI_SPLIT_IMAGES;

const TELEGRAM_BOT_URL = `https://api.telegram.org/bot${TELEGRAM_API_TOKEN}`;



deepai.setApiKey(DEEP_AI_KEY);

const DEEP_AI_OUTPUT_DIR = path.resolve(`${__dirname}${path.sep}..`, ".deepai_out");

imageToSlices.configure({
  clipperOptions: {
      canvas: require('canvas'),
      quality: 100,
  },
});



const app = express();

app.post('/tg', bodyParser.json(), async (req, res, next) => {
  console.log(req.body);

  if (req.headers['x-telegram-bot-api-secret-token'] !== TELEGRAM_SECRET_KEY) {
    console.log("NOT TELEGRAM!");
    res.status(401).send({});
    return;
  }

  res.status(200).send({});

  const message = req.body.message;

  if (message == null) {
    console.log("Message is NULL.");
    return;
  }

  const messageId = message.message_id;
  const chatId = message.chat.id;
  const sentMessage = message.text;

  if (sentMessage != null && sentMessage.startsWith(MESSAGE_TOKEN)) {
    const message = sentMessage.substr(MESSAGE_TOKEN.length).replace(/\s/g, ' ').trim();

    if (message.length > 0) {
      console.log(message);

      if (PREFFER_DEEPAI == "1") {
        console.log("Using Deep AI");
        processWithDeepAI(chatId, messageId, message);
      } else {
        console.log("Using stability AI");
        processWithStabilityAI(chatId, messageId, message);
      }
    } else {
      console.log("Message text is empty.");
    }
  } else {
    console.log("Message text is NULL or does not start with the TOKEN.");
  }
});

app.get('*', (req, res) => {
  res.send("No GUI available :(");
});

async function processWithStabilityAI(chatId, messageId, message) {
  try {
    const result = await generateAsync({
      prompt: message,
      apiKey: STABILITY_KEY,
      diffusion: "k_lms",
      cfgScale: 20,
      steps: 52,
      height: 512,
      width: 512,
    });

    console.log(JSON.stringify({
      res: result.res,
      ...result.images.map((img, _, __) => ({
        filePath: img.filePath,
        seed: img.seed,
        mimeType: img.mimeType,
        classifications: img.classifications,
      })),
    }));

    if (result.images.length == 0) {
      try {
        await axios.post(`${TELEGRAM_BOT_URL}/sendMessage`, {
          chat_id: chatId,
          text: "Unfortunatelly, no images were generated for your request.",
          reply_to_message_id: messageId,
        });
      } catch (e) {
        console.log(e);
      }

      return;
    }

    result.images.forEach(image => {
      console.log(image.filePath);

      fs.stat(image.filePath, async (err, stats) => {
        if (err) {
          return;
        }

        const formData = new FormData();

        formData.append('chat_id', chatId);
        formData.append('photo', fs.createReadStream(image.filePath));
        formData.append('reply_to_message_id', messageId);

        try {
          await axios.post(`${TELEGRAM_BOT_URL}/sendPhoto`, formData, {
            headers: formData.getHeaders()
          });
        } catch (e) {
          console.log(e);
        }

        fs.stat(image.filePath, (err, stats) => {
          if (err == null) {
            fs.rm(path.dirname(image.filePath), { recursive: true }, (err) => {
            })
          }
        });
      });
    });
  } catch (e) {
    console.log(`An error occurred: ${e}`);
  }
}

async function processWithDeepAI(chatId, messageId, message) {
  const cancelStatusUpdates = continuouslySetUploadingImageStatus(chatId);

  try {
    const result = await deepai.callStandardApi("text2img", {
      text: message,
    });

    console.log(result);

    if (result != null && result.output_url != null && result.output_url.length > 0) {
      const imageUrl = result.output_url;

      do {
        if (DEEPAI_SPLIT_IMAGES == "1") {
          console.log("Splitting image");
          const outputDir = path.resolve(DEEP_AI_OUTPUT_DIR, uuid4());

          try {
            await new Promise((resolve, reject) => {
              fs.mkdir(outputDir, { recursive: true, }, async err => {
                if (err == null) {
                  try {
                    axios.post(`${TELEGRAM_BOT_URL}/sendChatAction`, {
                      chat_id: chatId,
                      action: "upload_photo",
                    });

                    imageToSlices(imageUrl, [512, 512], [512, 512], { saveToDir: outputDir, }, async () => {
                      console.log("Reading directory with slices");
                      fs.readdir(outputDir, async (err, files) => {
                        if (err == null) {
                          let promises = [];
                          let promiseResolved = false;
  
                          console.log(files);
  
                          files.forEach(file => {
                            const filePath = path.resolve(outputDir, file);

                            promises.push(new Promise(async (r, _) => {
                              const formData = new FormData();
  
                              formData.append('chat_id', chatId);
                              formData.append('photo', fs.createReadStream(filePath));
                              formData.append('reply_to_message_id', messageId);
                              
                              try {
                                await axios.post(`${TELEGRAM_BOT_URL}/sendPhoto`, formData, {
                                  headers: formData.getHeaders()
                                });

                                cancelStatusUpdates();
                                promiseResolved = true;
                              } catch (e) {
                                console.log(e);
                              }
                            
                              r();
                            }));
                          });
  
                          await Promise.all(promises);
  
                          fs.rm(outputDir, { recursive: true, }, (err) => {
                            if (err != null) {
                              console.log(err);
                            }

                            if (promiseResolved) {
                              resolve();
                            } else {
                              reject();
                            }
                          });
                        } else {
                          reject();
                          console.log(err);
                        }
                      })
                    });
                  } catch (e) {
                    reject();
                    console.log(e);
                  }
                } else {
                  reject();
                  console.log(err);
                }
              });
            });

            break;
          } catch (e) {
            console.log(e);
          }
        }

        console.log("Sending original photo");

        try {
          cancelStatusUpdates();

          await axios.post(`${TELEGRAM_BOT_URL}/sendPhoto`, {
            chat_id: chatId,
            reply_to_message_id: messageId,
            photo: imageUrl,
          });
        } catch (e) {
          console.log(e);
        }
      } while (false);
    } else {
      cancelStatusUpdates();

      try {
        await axios.post(`${TELEGRAM_BOT_URL}/sendMessage`, {
          chat_id: chatId,
          text: "Unfortunatelly, no images were generated for your request.",
          reply_to_message_id: messageId,
        });
      } catch (e) {
        console.log(e);
      }
    }
  } catch (e) {
    cancelStatusUpdates();
    console.log(e);
  }
}

function continuouslySetUploadingImageStatus(chatId) {
  const maxRequestNumber = 6;
  const requestInterval = 4500;

  let requestNumber = 0;
  let timer = null;
  let inProgress = true;

  const clearTimer = () => {
    if (timer != null) {
      console.log(`upload_photo status updates cancelled, requestNumber=${requestNumber}`);
      clearInterval(timer);
      timer = null;
    }
  }

  const setStatus = async () => {
    try {
      console.log(`Set upload_photo status, requestNumber=${requestNumber}`);
      await axios.post(`${TELEGRAM_BOT_URL}/sendChatAction`, {
        chat_id: chatId,
        action: "upload_photo",
      });
      console.log("Set upload_photo status finished");
    } catch (e) {
      console.log(e);
    }
  };

  (async () => {
    timer = setInterval(async () => {
      if (requestNumber > maxRequestNumber) {
        clearTimer();
        return;
      }
  
      requestNumber++;
  
      if (inProgress) {
        return;
      }
  
      inProgress = true;
      await setStatus();
      inProgress = false;
    }, requestInterval);

    await setStatus();
    inProgress = false;
  })();

  return clearTimer;
}

// Listen to port

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => console.log(`Listening to port: ${PORT}`));
