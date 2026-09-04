const express = require("express");
const axios = require("axios");
const getRawBody = require("raw-body");
const jwt = require("jsonwebtoken");
const ZOOM_API = "https://api.zoom.us/v2";
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { connectTodb } = require("../db/connection");
const { mandatory: authenticate } = require("../middleware/auth.middleware");
const { selectTenantDB } = require("../middleware/selectTenantDB.middleware");
const mongoDB = require("mongodb");
const { getTenantDB } = require("../db/connection");
const { zoomMeetingsCollection, topicsCollection } = require("../db/connection").getGlobalCollections();
const router = express.Router();

const app = express();

app.use(authenticate);
app.use(selectTenantDB);

app.use(cors());
app.use(express.json());
const SDK_KEY = "srx4lVF8RYOwzAbfG3O9oQ";
const SDK_SECRET = "oBf40345aHfliOywWGE9xzvrnWbEwGqa";

// utils/zoomAuth.js

async function getZoomAccessToken() {
  const { ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_ACCOUNT_ID } = process.env;
  const tokenRes = await axios.post("https://zoom.us/oauth/token", null, {
    params: {
      grant_type: "account_credentials",
      account_id: ZOOM_ACCOUNT_ID,
    },
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`
      ).toString("base64")}`,
    },
  });
  return tokenRes.data.access_token;
}

module.exports.getRecordedMeeting = async (req, res) => {
  // const { zoomMeetingsCollection } = connectTodb(req.tenantDB);
  // if (!req.tenantDB)
  // return res.status(500).json({ error: "No tenant DB available" });
  try {
    const event = req.body.event;
    const payload = req.body.payload;

    if (event !== "recording.completed") {
      return res.status(400).json({ message: "Unhandled event" });
    }

    const meetingId = payload.object.id;
    const zoomUuid = payload.object.uuid;

    const meetingDoc = await zoomMeetingsCollection.findOne({
      "meetingDetails.id": meetingId,
    });

    if (!meetingDoc) {
      console.warn("No internal record found for meeting", meetingId);
      return res.status(200).json("Meeting not found");
    }

    const zoomCollectionId = meetingDoc._id.toString();
    const token = await getZoomAccessToken(
      "jhLjbNleS2OWVZ2thQzqRw",
      "MpcqCmBYTz6v20gt2ZWyfQ"
    );

    const { data } = await axios.get(
      `https://api.zoom.us/v2/meetings/${meetingId}/recordings`,
      {
        headers: { Authorization: "Bearer " + token },
      }
    );

    const recordingFiles = data.recording_files || [];
    const uploadedFiles = [];

    for (const file of recordingFiles) {
      if (file.file_type !== "MP4" || !file.download_url) continue;

      const downloadUrl = `${file.download_url}?access_token=${token}`;
      const filename = `${uuidv4()}.mp4`;
      const filepath = path.join(__dirname, "../uploads", filename);

      fs.mkdirSync(path.dirname(filepath), { recursive: true });

      const writer = fs.createWriteStream(filepath);
      const response = await axios({
        url: downloadUrl,
        method: "GET",
        responseType: "stream",
      });

      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const form = new FormData();
      form.append("file", fs.createReadStream(filepath));

      const s3Response = await axios.post(
        `${process.env.REST_URL}/uploadToS3?bucketName=zoom-classes-recordings`,
        form,
        {
          headers: form.getHeaders(),
        }
      );

      fs.unlinkSync(filepath);

      uploadedFiles.push({
        localFile: filename,
        s3Url: s3Response.data.file,
      });
    }

    await zoomMeetingsCollection.updateOne(
      {
        _id: new ObjectId(zoomCollectionId),
      },
      {
        $set: {
          recordedUrl: uploadedFiles?.[0]?.s3Url,
        },
      }
    );

    await axios.delete(
      `https://api.zoom.us/v2/meetings/${meetingId}/recordings`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    res.status(200).json("uploadedFiles");
  } catch (error) {
    console.error("Zoom Webhook Error:", error);
    res.status(200).json(" message: error.message ");
  }
};

module.exports.createMeeting = async (req, res) => {
  // const { zoomMeetingsCollection, topicsCollection } = connectTodb(req.tenantDB);
  // if (!req.tenantDB)
  // return res.status(500).json({ error: "No tenant DB available" });
  try {
    const token = await getZoomAccessToken();
    const { topic, topicId } = req.body;

    const findMeeting = await zoomMeetingsCollection.findOne({
      $and: [
        { topic },
        { $or: [{ isCompleted: false }, { isCompleted: { $exists: false } }] },
      ],
    });

    if (findMeeting && !findMeeting?.isCompleted) {
      res
        .status(200)
        .json({ msg: "meeting already created", data: findMeeting });
    } else {
      const zoomRes = await axios.post(
        `https://api.zoom.us/v2/users/me/meetings`,
        {
          topic,
          type: 2,
          settings: {
            host_video: true,
            participant_video: false,
            panelist_join_before_host: false,
            auto_recording: "cloud",
            cloud_recording: true,
            focus_mode: true,
          },
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const zoomCreatedData = await zoomMeetingsCollection.insertOne({
        ...req.body,
        topic,
        isCompleted: false,
        meetingDetails: zoomRes.data,
        createdAt: new Date().getTime(),
      });

      await topicsCollection.updateOne(
        { _id: new ObjectId(topicId) },
        {
          $set: {
            meetingId: zoomCreatedData?.insertedId?.toString(),
          },
        }
      );
      return res.json({ meeting: zoomRes.data });
    }
  } catch (err) {
    // Log Zoom’s error payload if available
    console.error(
      "Zoom create meeting error:",
      err.response?.data || err.message
    );
    const status = err.response?.status || 500;
    const message = err.response?.data || err.message;
    return res.status(status).json({ error: message });
  }
};

module.exports.getMeetingDetails = async (req, res) => {
  const { orgId, topic, id } = req.body;

  try {
    const findMeeting = await zoomMeetingsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!findMeeting) {
      return res.status(200).json({ message: "Meeting not created for this topic" });
    }

    try {
      const token = await getZoomAccessToken();
      const zoomReq = await axios.get(`https://api.zoom.us/v2/meetings/${findMeeting.meetingDetails.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      findMeeting.liveStatus = zoomReq.data.status;
    } catch (err) {
      // Fallback if the Zoom API call fails
      findMeeting.liveStatus = "unknown";
    }

    res.status(200).json({ data: findMeeting });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
// module.exports.getAllMeetings = async (req, res) => {
//   try {

//     const {limit , cursor , type} = req.query
//     const findMeeting = await zoomMeetingsCollection
//       .find({})
//       .sort({ createdAt: -1 })
//       .toArray();

//     res.status(200).json({ data: findMeeting });
//   } catch (error) {
//     res.status(500).json({ err: error.message });
//   }
// };

module.exports.getAllMeetings = async (req, res) => {
  // const { zoomMeetingsCollection } = connectTodb(req.tenantDB);
  // if (!req.tenantDB)
  // return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { limit = 10, cursor, type } = req.query;
    const parsedLimit = parseInt(limit, 10);

    const pipeline = [];

    // Build match stage for optional type filter and cursor-based pagination
    const matchStage = {};
    if (type) {
      matchStage.type = type;
    }
    if (cursor && cursor !== "null") {
      // Compare createdAt field directly (assuming string or Date)
      matchStage.createdAt = { $lt: cursor };
    }
    if (Object.keys(matchStage).length) {
      pipeline.push({ $match: matchStage });
    }

    // Sort by createdAt descending (newest first)
    pipeline.push({ $sort: { createdAt: -1 } });

    // Limit (fetch one extra to determine if there is a next page)
    pipeline.push({ $limit: parsedLimit + 1 });

    // Execute aggregation on the zoomMeetingsCollection collection
    const meetings = await zoomMeetingsCollection.aggregate(pipeline).toArray();

    const hasNext = meetings.length > parsedLimit;
    if (hasNext) {
      meetings.pop();
    }

    // Next cursor is the createdAt of the last item in this batch
    const nextCursor = hasNext ? meetings[meetings.length - 1].createdAt : null;

    res.status(200).json({
      data: meetings,
      hasNext,
      nextCursor,
    });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

module.exports.updateMeeting = async (req, res) => {
  // const { zoomMeetingsCollection } = connectTodb(req.tenantDB);
  // if (!req.tenantDB)
  // return res.status(500).json({ error: "No tenant DB available" });
  try {
    const { id } = req.params;

    const updatedData = await zoomMeetingsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: { ...req.body, updatedAt: new Date().getTime() },
        $setOnInsert: { createdAt: new Date().getTime() },
      },
      { returnDocument: "after", upsert: true }
    );

    res
      .status(200)
      .json({ msg: "Meeting updated successfully", data: updatedData });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};

function generateSignature(meetingNumber, role) {
  const timestamp = new Date().getTime() - 30000;
  const msg = Buffer.from(
    `${SDK_KEY}${meetingNumber}${timestamp}${role}`
  ).toString("base64");
  const hash = crypto
    .createHmac("sha256", SDK_SECRET)
    .update(msg)
    .digest("base64");
  const rawSig = `${SDK_KEY}.${meetingNumber}.${timestamp}.${role}.${hash}`;
  // convert to URL-safe Base64
  return Buffer.from(rawSig)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

module.exports.signature = (req, res) => {
  try {
    const { meetingNumber, role } = req.body;

    if (!meetingNumber || role === undefined) {
      return res
        .status(400)
        .json({ error: "meetingNumber & role are required" });
    }

    const iat = Math.floor(Date.now() / 1000) - 30;
    const exp = iat + 60 * 2; // signature valid for 2 minutes
    const payload = {
      sdkKey: SDK_KEY,
      mn: meetingNumber,
      role,
      iat,
      exp,
    };

    const signature = jwt.sign(payload, SDK_SECRET, { algorithm: "HS256" });
    return res.json({ signature, sdkKey: SDK_KEY });
  } catch (error) {
    res.status(500).json({ err: error.message });
  }
};
