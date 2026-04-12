import express from "express";
import axios from "axios";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "https://diasposante.goodbarber.app",
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "50mb" }));

const BASEROW_TOKEN = process.env.BASEROW_TOKEN;
const TABLE_DOCUMENTS = process.env.TABLE_DOCUMENTS;
const TABLE_MESURES = process.env.TABLE_MESURES;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------------------------------
// OCR IMAGE
// -----------------------------------------------------
async function ocrImage(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");
  const result = await Tesseract.recognize(buffer, "fra");
  return result.data.text;
}

// -----------------------------------------------------
// OCR PDF
// -----------------------------------------------------
async function ocrPDF(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");
  const pdf = await pdfParse(buffer);
  return pdf.text;
}

// -----------------------------------------------------
// IA DOCUMENTS (TEXTE) AVEC FALLBACK
// -----------------------------------------------------
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
      messages: [{ role: "user", content: prompt }],
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("Erreur IA, fallback activé :", err.message);

    return {
      type_document: "",
      medicaments: [],
      examens: [],
      diagnostic: "",
      Recommendations: [],
      alertes: ["Analyse IA indisponible (quota épuisé)"],
    };
  }
}

// -----------------------------------------------------
// ENDPOINT DOCUMENTS : /analyse-document
// -----------------------------------------------------
app.post("/analyse-document", async (req, res) => {
  try {
    console.log("Requête reçue :", req.body);

    const { documentId, cloudinaryUrl, typeDocument } = req.body;

    if (!documentId || !cloudinaryUrl) {
      return res
        .status(400)
        .json({ error: "documentId et cloudinaryUrl obligatoires" });
    }

    let texte = "";
    if (cloudinaryUrl.toLowerCase().endsWith(".pdf")) {
      texte = await ocrPDF(cloudinaryUrl);
    } else {
      texte = await ocrImage(cloudinaryUrl);
    }

    const analyse = await analyseTexteIA(texte);

    const payload = {
      field_7950031: texte, // TexteExtrait
      field_7950032: JSON.stringify(analyse), // AnalyseIA
      field_7651257: typeDocument || "", // Type du document
    };

    if (typeDocument) payload.field_7651257 = typeDocument;

    try {
      await axios.patch(
        `https://api.baserow.io/api/database/rows/table/841992/${documentId}/`,
        payload,
        {
          headers: {
            Authorization: `Token ${BASEROW_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error("Erreur Baserow :", err.response?.data || err.message);
    }

    console.log("Analyse enregistrée dans Baserow (avec ou sans IA)");

    res.json({ success: true, analyse });
  } catch (err) {
    console.error("Erreur analyse :", err);
    res.status(500).json({ error: "Erreur analyse document" });
  }
});

// -----------------------------------------------------
// ENDPOINT MESURES : /analyse-mesure
// -----------------------------------------------------
app.post("/analyse-mesure", async (req, res) => {
  try {
    console.log("Requête analyse mesure :", req.body);

    const { cloudinaryUrl, patientId } = req.body;

    if (!cloudinaryUrl || !patientId) {
      return res
        .status(400)
        .json({ error: "cloudinaryUrl et patientId obligatoires" });
    }

    const prompt = `
Tu es un assistant médical. Analyse cette photo et renvoie STRICTEMENT un JSON valide.

Détecte :
- "type" : type de mesure (tension, glycémie, température, SpO2, poids…)
- "valeur" : valeur exacte (ex: "147/95", "1.32", "38.4")
- "unite" : unité (mmHg, g/L, °C, %, kg…)
- "qualite_photo" : bonne, moyenne, mauvaise
- "alerte" : normale, élevée, critique
- "analyse" : résumé médical court
- "recommandations" : tableau de recommandations

Format JSON strict :
{
  "type": "",
  "valeur": "",
  "unite": "",
  "qualite_photo": "",
  "alerte": "",
  "analyse": "",
  "recommandations": []
}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: prompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: cloudinaryUrl },
            },
          ],
        },
      ],
    });

    const analyseIA = JSON.parse(completion.choices[0].message.content);

    // -----------------------------------------------------
    // RÉCUPÉRER LES ANCIENNES MESURES DU PATIENT
    // -----------------------------------------------------
    const mesuresResp = await axios.get(
      `https://api.baserow.io/api/database/rows/table/794957/?user_field_names=true`,
      {
        headers: { Authorization: `Token ${BASEROW_TOKEN}` },
      }
    );

    const anciennes = mesuresResp.data.results.filter(
      (m) => m.Patient === patientId
    );

    let evolution = "";

    if (anciennes.length > 0) {
      const last = anciennes[anciennes.length - 1];

      if (
        typeof analyseIA.valeur === "string" &&
        typeof last.Valeur === "string" &&
        analyseIA.valeur.includes("/") &&
        last.Valeur.includes("/")
      ) {
        const [sysNew, diaNew] = analyseIA.valeur.split("/").map(Number);
        const [sysOld, diaOld] = last.Valeur.split("/").map(Number);

        const dSys = sysNew - sysOld;
        const dDia = diaNew - diaOld;

        evolution = `${dSys >= 0 ? "+" : ""}${dSys}/${
          dDia >= 0 ? "+" : ""
        }${dDia}`;
      }
    }

    // -----------------------------------------------------
    // ENREGISTRER DANS BASEROW
    // (adapte les noms de champs à ta table Mesures)
// -----------------------------------------------------
    const payloadMesure = {
      Patient: patientId,
      Type: analyseIA.type,
      Valeur: analyseIA.valeur,
      Unite: analyseIA.unite,
      Evolution: evolution,
      AnalyseIA: JSON.stringify(analyseIA),
      Photo: cloudinaryUrl,
    };

    await axios.post(
      `https://api.baserow.io/api/database/rows/table/794957/?user_field_names=true`,
      payloadMesure,
      {
        headers: {
          Authorization: `Token ${BASEROW_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      success: true,
      mesure: analyseIA,
      evolution,
    });
  } catch (err) {
    console.error("Erreur analyse mesure :", err.response?.data || err.message);
    res.status(500).json({ error: "Erreur analyse mesure" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Backend IA opérationnel avec documents + mesures");
});


