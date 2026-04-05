import express from "express";
import axios from "axios";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

app.use(cors({
  origin: "https://diasposante.goodbarber.app",
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "50mb" }));

const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const TABLE_DOCUMENTS = process.env.TABLE_DOCUMENTS;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// OCR IMAGE
async function ocrImage(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");
  const result = await Tesseract.recognize(buffer, "fra");
  return result.data.text;
}

// OCR PDF
async function ocrPDF(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");
  const pdf = await pdfParse(buffer);
  return pdf.text;
}

// IA AVEC FALLBACK
async function analyseTexteIA(texte) {
  const prompt = `
Analyse ce document médical et renvoie STRICTEMENT un JSON valide :

{
  "type_document": "",
  "medicaments": [],
  "examens": [],
  "diagnostic": "",
  "recommandations": [],
  "alertes": []
}

Texte :
${texte}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });

    return JSON.parse(completion.choices[0].message.content);

  } catch (err) {
    console.error("Erreur IA, fallback activé :", err.message);

    // FALLBACK IA
    return {
      type_document: "",
      medicaments: [],
      examens: [],
      diagnostic: "",
      recommandations: [],
      alertes: ["Analyse IA indisponible (quota épuisé)"]
    };
  }
}

// ENDPOINT PRINCIPAL
app.post("/analyse-document", async (req, res) => {
  try {
    console.log("Requête reçue :", req.body);

    const { documentId, cloudinaryUrl, ownerId, patientId, typeDocument } = req.body;

    if (!documentId || !cloudinaryUrl) {
      return res.status(400).json({ error: "documentId et cloudinaryUrl obligatoires" });
    }

    // OCR
    let texte = "";
    if (cloudinaryUrl.toLowerCase().endsWith(".pdf")) {
      texte = await ocrPDF(cloudinaryUrl);
    } else {
      texte = await ocrImage(cloudinaryUrl);
    }

    // IA (avec fallback)
    const analyse = await analyseTexteIA(texte);

    // Payload Baserow
    const payload = {
      TexteExtrait: texte,
      AnalyseIA: JSON.stringify(analyse)
    };

    if (typeDocument) payload.TypeDocument = typeDocument;
    if (ownerId) payload.Owner = [ownerId];
    if (patientId) payload.Patient = [patientId];

    // Mise à jour Baserow
    await axios.patch(
      `https://api.baserow.io/api/database/rows/table/841992/${documentId}/`,
      payload,
      {
        headers: {
          Authorization: `Token ${BASEROW_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("Analyse enregistrée dans Baserow (avec ou sans IA)");

    res.json({ success: true, analyse });

  } catch (err) {
    console.error("Erreur analyse :", err);
    res.status(500).json({ error: "Erreur analyse document" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Backend IA opérationnel avec fallback");
});


