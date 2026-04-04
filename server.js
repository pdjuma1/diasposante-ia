import express from "express";
import axios from "axios";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

// ===============================
// CORS — ESSENTIEL POUR GOODBARBER
// ===============================
app.use(cors({
  origin: "https://diasposante.goodbarber.app",
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "50mb" }));

// ===============================
// CONFIG
// ===============================
const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const TABLE_DOCUMENTS = process.env.TABLE_DOCUMENTS;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===============================
// OCR IMAGE
// ===============================
async function ocrImage(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");

  const result = await Tesseract.recognize(buffer, "fra", {
    logger: m => console.log(m)
  });

  return result.data.text;
}

// ===============================
// OCR PDF
// ===============================
async function ocrPDF(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");

  const pdf = await pdfParse(buffer);
  return pdf.text;
}

// ===============================
// IA — ANALYSE DU TEXTE
// ===============================
async function analyseTexteIA(texte) {
  const prompt = `
Analyse ce document médical et renvoie STRICTEMENT un JSON valide :

{
  "type_document": "",
  "medicaments": [
    { "nom": "", "dose": "", "frequence": "", "duree": "" }
  ],
  "examens": [],
  "diagnostic": "",
  "recommandations": [],
  "alertes": []
}

Règles :
- N'invente rien
- Extrait uniquement ce qui est présent dans le texte
- Si une info manque, laisse vide
- "alertes" doit contenir des risques, interactions ou incohérences

Texte :
${texte}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ===============================
// ENDPOINT PRINCIPAL
// ===============================
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

    // Analyse IA
    const analyse = await analyseTexteIA(texte);

    // Préparation payload Baserow
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

    console.log("Analyse IA enregistrée dans Baserow");

    res.json({ success: true, analyse });

  } catch (err) {
    console.error("Erreur analyse :", err);
    res.status(500).json({ error: "Erreur analyse document" });
  }
});

// ===============================
// LANCEMENT SERVEUR
// ===============================
app.listen(process.env.PORT || 3000, () => {
  console.log("Backend IA opérationnel sur Render");
});

