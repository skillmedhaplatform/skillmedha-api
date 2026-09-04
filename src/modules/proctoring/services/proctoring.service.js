require("dotenv").config({
  path: "../../.env",
});
const express = require("express");

const {
  Rekognition,
  DetectLabelsCommand,
  SearchFacesByImageCommand,
  IndexFacesCommand,
  CompareFacesCommand,
} = require("@aws-sdk/client-rekognition");
const mongoDB = require("mongodb");
const fs = require("fs");
const path = require("path");
const { rmSync } = require("fs");
const cors = require("cors");
const {
  getTotalPersons,
  checkExtraDevices,
} = require("./proctoringHelper.service");
// const { student } = require("../../mongoDB");
const { ObjectId } = require("mongodb");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { getTenantDB } = require("../../../shared/db/connection");
const app = express.Router();
const port = 6886;








const rekog = new Rekognition({
  credentials: {
    accessKeyId: process.env.AWS_REKOG_KEY,
    secretAccessKey: process.env.AWS_REKOG_SECRET,
  },

  region: process.env.AWS_REGION,
});

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const convertbase64ToBlob = (file, name) => {
  let base64ImageNew = file.split(";base64,").pop();
  fs.writeFileSync(
    "./uploads/" + name,
    base64ImageNew,
    { encoding: "base64" },
    function (err) {}
  );
  const fileContentNew = fs.readFileSync("./uploads/" + name);
  return fileContentNew;
};

const detectlabels = (file, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    Image: {
      Bytes: fileContent,
    },
    Features: ["GENERAL_LABELS"],
    Settings: {
      GeneralLabels: {
        LabelCategoryInclusionFilters: [
          "Education",
          "Person Description",
          "Text and Documents",
          "Technology and Computing",
        ],
      },
    },
  };

  return rekog.send(new DetectLabelsCommand({ ...params }));
};

app.post("/detectlabels", async (req, res) => {
  const fileName = "detectFace.png";
  try {
    const data = await detectlabels(req.body.img, fileName);
    rmSync(`./uploads/${fileName}`);
    const numPersons = getTotalPersons(data.Labels);
    const checkDevices = checkExtraDevices(data.Labels);
    res.json({ data, numPersons, checkDevices });
  } catch (error) {
    console.error(error);
    // rmSync(`./uploads/${fileName}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

const indexFacesFunc = (file, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    CollectionId: "student_faces",
    DetectionAttributes: ["ALL"],
    Image: {
      Bytes: fileContent,
    },
    MaxFaces: 1,
    QualityFilter: "HIGH",
  };
  return rekog.send(new IndexFacesCommand(params));
};

app.post("/indexFaces", async (req, res) => {
  const fileName = "indexFace.png";
  const { student } = getTenantDB(req.tenantDB);
  try {
    const indexData = await indexFacesFunc(req.body.img);
    rmSync(`./uploads/${fileName}`);
    const { studentId } = req.body;
    const updateStudent = await student.findOneAndUpdate(
      { _id: new ObjectId(studentId) },
      {
        $set: {
          faceIndexData: indexData,
        },
      }
    );
    res.send({ data: indexData });
  } catch (error) {
    // rmSync(`./uploads/${fileName}`);
    res.send({ err: error.message });
  }
});

const searchFacesByImageFun = (file, faceData, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    CollectionId: "student_faces",
    FaceMatchThreshold: number,
    Image: {
      Bytes: fileContent,
    },
    MaxFaces: 1,
    QualityFilter: "HIGH",
  };
  return rekog.send(new SearchFacesByImageCommand(params));
};

const compareFacesFun = async (newFace, newFileName, faceData, bucket_name) => {
  const fileContentNew = convertbase64ToBlob(newFace, newFileName);

  const params = {
    QualityFilter: "HIGH",
    SimilarityThreshold: 90,
    SourceImage: {
      Bytes: fileContentNew,
    },
    TargetImage: {
      S3Object: {
        Bucket: bucket_name,
        Name: faceData.key,
      },
    },
  };
  return rekog.send(new CompareFacesCommand(params));
};

app.post("/compareFaces", async (req, res) => {
  const newFileName = "newFace.png";
  const { student } = getTenantDB(req.tenantDB);
  try {
    const { studentId } = req.body;
    const { bucket_name } = req.body;

    const studentData = await student.findOne({
      _id: new ObjectId(studentId),
    });
    const compareFaces = await compareFacesFun(
      req.body.img,
      newFileName,
      studentData.faceData,
      bucket_name
    );
    rmSync(`./uploads/${newFileName}`);
    res.send({ data: compareFaces });
  } catch (error) {
    // rmSync(`./uploads/${newFileName}`);
    res.send({ err: error.message });
  }
});

module.exports = app;
