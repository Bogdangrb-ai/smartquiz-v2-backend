require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Verificăm dacă cheile sunt încărcate în memorie
console.log("LOG: Pornire diagnosticare...");
console.log("LOG: URL este:", process.env.SUPABASE_URL ? "OK" : "LIPSEȘTE");
console.log("LOG: KEY este:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "OK" : "LIPSEȘTE");

const supabase = createClient(
    process.env.SUPABASE_URL || '', 
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

app.get('/', (req, res) => res.send('Motorul e ONLINE!'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("LOG: Serverul rulează pe portul", PORT);
});
