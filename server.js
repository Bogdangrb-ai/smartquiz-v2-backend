require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(require('cors')());

// Această funcție face toată treaba singură
app.post('/api/generate-quiz', upload.single('file'), async (req, res) => {
    try {
        // 1. Încarcă automat în Supabase
        const fileName = `${Date.now()}-${req.file.originalname}`;
        const { data: upData, error: upError } = await supabase.storage
            .from('uploads').upload(fileName, req.file.buffer);
        
        if (upError) throw upError;

        // 2. Ia link-ul public al pozei
        const { data: { publicUrl } } = supabase.storage.from('uploads').getPublicUrl(fileName);

        // 3. Trimite la OpenAI să "citească" poza și să facă testul
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "Ești un profesor expert. Generează un quiz de 5 întrebări grilă din poza primită, în format JSON curat." },
                { role: "user", content: [ { type: "image_url", image_url: { url: publicUrl } } ] }
            ],
            response_format: { type: "json_object" }
        });

        // 4. Trimite quiz-ul direct înapoi la elev
        res.json(JSON.parse(response.choices[0].message.content));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(10000, () => console.log("Sistem autonom pornit!"));
