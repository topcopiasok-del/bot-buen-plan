require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const firebase = require('firebase/app');
require('firebase/auth');
require('firebase/database');

// Configuración de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuración de Firebase
const firebaseConfig = {
    apiKey: "AIzaSyD3GgbLx3O_CawX-t1iNaJzQQYLc3OiBB0",
    authDomain: "buen-plan-pos.firebaseapp.com",
    databaseURL: "https://buen-plan-pos-default-rtdb.firebaseio.com",
    projectId: "buen-plan-pos",
    storageBucket: "buen-plan-pos.firebasestorage.app",
    messagingSenderId: "391944185005",
    appId: "1:391944185005:web:f4b60bd09563bbe0789224"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

// Variables Globales
let dynamicContext = "Cargando catálogo...";
const mutedUsers = new Map();
const messageCounts = new Map();
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const ANTI_ABUSE_MINUTES = 15 * 60 * 1000;

async function initFirebase() {
    try {
        console.log("Conectando a la base de datos de Buen Plan...");
        await firebase.auth().signInWithEmailAndPassword(process.env.FIREBASE_EMAIL, process.env.FIREBASE_PASSWORD);
        const uid = firebase.auth().currentUser.uid;
        console.log("¡Conectado a Firebase exitosamente!");

        const dbRef = firebase.database().ref(`usuarios/${uid}/buenplan_db`);
        
        dbRef.on('value', (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                
                const cfg = data.configuracion || {};
                const byn_simple = cfg.byn_simple || 40;
                const byn_doble = cfg.byn_doble || 70;
                const color_simple = cfg.color_simple || 250;
                const color_doble = cfg.color_doble || 350;
                const anillado_base = cfg.anillado_base || 1500;
                const anillado_extra = cfg.anillado_extra || 500;
                const banco = cfg.banco || "BUENPLAN.MP";

                let apuntesStr = "";
                if (data.apuntes) {
                    const apuntes = Object.values(data.apuntes);
                    apuntes.forEach(ap => {
                        let profe = data.profesores && data.profesores[ap.profesorId] ? data.profesores[ap.profesorId].nombre : "General";
                        apuntesStr += `- "${ap.titulo}" (Profe: ${profe}). Precio Fijo: $${ap.precio}\n`;
                    });
                }
                if (apuntesStr === "") apuntesStr = "No hay apuntes cargados en este momento.";

                dynamicContext = `
CATÁLOGO DE APUNTES DISPONIBLES:
${apuntesStr}

REGLAS DE PRECIOS BASE PARA IMPRESIONES SUELTAS (Papel A4 Obra):
- Blanco y Negro: $${byn_simple} (Simple Faz) / $${byn_doble} (Doble Faz, por HOJA).
- A Color: $${color_simple} (Simple Faz) / $${color_doble} (Doble Faz, por HOJA).
- Costo de Anillado: Valor base de $${anillado_base} (hasta 50 hojas). Se suman $${anillado_extra} por cada tramo extra de 50 hojas.

DATOS DE PAGO:
Para abonar, el cliente debe transferir al alias: ${banco}.
`;
                console.log("¡Catálogo y precios actualizados en la memoria de la IA!");
            }
        });
    } catch (error) {
        console.error("Error al conectar con Firebase:", error);
    }
}

const BASE_PROMPT = `Eres el asistente virtual de "Buen Plan", papelería y centro de copiado.
Trata al cliente de "vos".

REGLAS ESTRICTAS DE RESPUESTA:
1. SIEMPRE DERIVAR AL LINK DE COTIZACIÓN AUTOMÁTICA: La regla de oro de este negocio es que los clientes suban sus archivos a nuestra web. Si un cliente quiere imprimir archivos (PDF, Word, Fotos) o pide apuntes de escuelas de Gesell, DEBES invitarlo a entrar a: https://buenplan.topcopiasok.workers.dev/alumnos explicándole que allí puede subir sus archivos, ver el catálogo completo y el sistema le dirá el precio exacto al instante.
2. PRECIOS ESTIMADOS: Si el cliente te pregunta un precio por acá de todas formas, usa la tabla de precios que tienes abajo, pero SIEMPRE aclarele que "Es un precio estimado" y volvé a sugerirle que lo cotice exacto en el link.
3. SI EL CLIENTE TE ENVÍA UN ARCHIVO POR AQUÍ: Dile que por cuestiones técnicas no cotizas archivos directamente en el chat, y que por favor entre al link https://buenplan.topcopiasok.workers.dev/alumnos para subirlo y encargar el pedido.
4. NO DES DETALLES INNECESARIOS: Sé directo. Siempre asume que las impresiones son en A4 Obra B&N por defecto.
5. TRABAJOS COMPLEJOS: Si piden medidas distintas (no A4), volantes, tarjetas, o trabajos raros, responde EXACTAMENTE: "Ese tipo de trabajos los cotizamos de forma personalizada. Un integrante del equipo te atenderá a la brevedad."
6. PRODUCTOS DE TIENDA: Si piden agendas o cuadernos de diseño físico, derívalos a: https://buenplan.ar

INFORMACIÓN EN TIEMPO REAL:
`;

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" })
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if(qr) {
            console.log("\n=======================================================================");
            console.log("¡ATENCIÓN! ESCANEA ESTE CÓDIGO QR CON EL WHATSAPP DE TU CELULAR");
            console.log("=======================================================================\n");
            qrcode.generate(qr, {small: true});
        }
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexión cerrada. ¿Intentando reconectar?:', shouldReconnect)
            if(shouldReconnect) connectToWhatsApp()
        } else if(connection === 'open') {
            console.log('✅ ¡Conectado exitosamente a WhatsApp! El bot ya está escuchando mensajes.')
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return; // Ignorar mensajes antiguos al iniciar

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const senderNumber = msg.key.remoteJid;
            const isOwnerTesting = senderNumber.includes('2267448815'); 

            if (msg.key.fromMe) {
                if (!senderNumber.includes('@g.us') && senderNumber !== 'status@broadcast') {
                    mutedUsers.set(senderNumber, Date.now());
                    console.log(`\n[MUTE] 🤐 Le respondiste a ${senderNumber.split('@')[0]}. Bot silenciado por 12 horas.`);
                }
                continue;
            }

            if (senderNumber.includes('@g.us') || senderNumber === 'status@broadcast') continue;

            if (mutedUsers.has(senderNumber) && !isOwnerTesting) {
                if (Date.now() - mutedUsers.get(senderNumber) < TWELVE_HOURS) {
                    continue;
                } else {
                    mutedUsers.delete(senderNumber); 
                }
            }

            if (!isOwnerTesting) {
                const now = Date.now();
                const userStats = messageCounts.get(senderNumber) || { count: 0, startTime: now };
                
                if (now - userStats.startTime > ANTI_ABUSE_MINUTES) {
                    userStats.count = 0;
                    userStats.startTime = now;
                }
                
                userStats.count += 1;
                messageCounts.set(senderNumber, userStats);

                if (userStats.count > 10) {
                    if (userStats.count === 11) {
                        await sock.sendMessage(senderNumber, { text: "Has realizado demasiadas consultas seguidas. Un integrante del equipo te atenderá de forma personalizada a la brevedad." });
                        mutedUsers.set(senderNumber, Date.now()); 
                    }
                    continue;
                }
            }

            let textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            // Detectar si mandó un archivo (Documento o Imagen) sin necesidad de descargarlo
            const docMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
            const imgMessage = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

            if (docMessage || imgMessage) {
                // Le pasamos esta pista invisible a Gemini para que sepa que el cliente mandó un archivo
                textMessage = "[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO ADJUNTO AL CHAT] " + (textMessage || "¿Cuánto sale imprimir esto?");
            }

            if (textMessage) {
                console.log(`\n💬 Procesando consulta de ${senderNumber.split('@')[0]}`);
                try {
                    await sock.sendPresenceUpdate('composing', senderNumber);

                    const model = genAI.getGenerativeModel({ 
                        model: "gemini-flash-latest",
                        systemInstruction: BASE_PROMPT + dynamicContext
                    });
                    
                    const result = await model.generateContent(textMessage);
                    const aiResponseText = result.response.text();

                    await sock.sendMessage(senderNumber, { text: aiResponseText });
                    console.log(`🤖 Respuesta enviada.`);
                    
                    if (aiResponseText.includes("integrante del equipo te atenderá")) {
                        mutedUsers.set(senderNumber, Date.now());
                        console.log(`[DERIVACIÓN] 👤 Bot silenciado para ${senderNumber.split('@')[0]}.`);
                    }

                    await sock.sendPresenceUpdate('paused', senderNumber);
                } catch (error) {
                    console.error("❌ Error al generar respuesta:", error.message);
                }
            }
        }
    })
}

initFirebase().then(() => {
    connectToWhatsApp();
});
