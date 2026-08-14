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
const chatHistories = new Map();
const messageQueues = new Map();
const DEBOUNCE_TIME = 20000;
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
                const plazo = cfg.plazo || "A confirmar";
                
                let profesStr = "";
                const profesList = data.profesores ? Object.values(data.profesores) : [];
                if (profesList.length > 0) {
                    profesStr = profesList.map(p => `- ${p.nombre}`).join("\n");
                }
                if (profesStr === "") profesStr = "No hay profesores registrados.";

                let apuntesStr = "";
                if (data.apuntes) {
                    const apuntes = Object.values(data.apuntes);
                    apuntes.forEach(ap => {
                        let profeObj = profesList.find(p => p.id === ap.profesorId);
                        let profe = profeObj ? profeObj.nombre : "General";
                        apuntesStr += `- "${ap.titulo}" (Profe: ${profe}). Precio Fijo: $${ap.precio}\n`;
                    });
                }
                if (apuntesStr === "") apuntesStr = "No hay apuntes cargados en este momento.";

                dynamicContext = `
CATÁLOGO DE APUNTES DISPONIBLES:
${apuntesStr}

PROFESORES / MATERIAS DISPONIBLES:
${profesStr}

REGLAS DE PRECIOS BASE PARA IMPRESIONES SUELTAS (Papel A4 Obra):
- Blanco y Negro: $${byn_simple} (Simple Faz) / $${byn_doble} (Doble Faz, por HOJA).
- A Color: $${color_simple} (Simple Faz) / $${color_doble} (Doble Faz, por HOJA).
- Costo de Anillado: Valor base de $${anillado_base} (hasta 50 hojas). Se suman $${anillado_extra} por cada tramo extra de 50 hojas.

DATOS DE PAGO:
Para abonar, el cliente debe transferir al alias: ${banco}.

FECHA DE ENTREGA ESTIMADA:
Los trabajos (impresiones) están listos para el día: ${plazo}. (Si te preguntan "para cuándo está", responde con esta fecha).
`;
                console.log("¡Catálogo y precios actualizados en la memoria de la IA!");
            }
        });
    } catch (error) {
        console.error("Error al conectar con Firebase:", error);
    }
}

const BASE_PROMPT = `Eres el asistente virtual de "Buen Plan", papelería y centro de copiado.
Trata al cliente de "vos", de forma amable y servicial.

REGLAS ESTRICTAS DE RESPUESTA:
1. SALUDOS GENÉRICOS: Si el cliente solo dice "Hola", "Buenas", "Buen día", etc., NO asumas que quiere imprimir ni le des precios. Responde amablemente algo simple como "¡Hola! Somos Buen Plan, ¿cómo podemos ayudarte?".
2. PRODUCTOS DE LA TIENDA: Si el cliente pregunta si venden agendas, cuadernos de diseño, libretas, souvenirs o regalos, respóndele que SÍ venden y que puede ver diseños y precios ingresando a: https://buenplan.ar
3. COTIZACIÓN DE IMPRESIONES: Si el cliente pregunta cuánto cuesta una impresión (A4, blanco y negro, color), utiliza los precios de la tabla inferior para darle un valor.
4. ARCHIVOS RECIBIDOS: Si el cliente envía un archivo o documento, lee la pista invisible que te dará el sistema. Si te indica la cantidad de páginas, COTIZA ese documento multiplicando por el precio de Blanco y Negro Simple Faz y dale el valor total estimado.
5. REGLA DEL ANILLADO: NUNCA des detalles de cómo se calcula el anillado (valor base, extra por hojas, etc). Simplemente dales el precio final. Si el archivo o pedido tiene MENOS de 40 páginas, NO ofrezcas anillarlo a menos que te lo pidan. Si tiene MÁS de 40 páginas, ofrécelo como una opción directa (Ejemplo: "En A4 simple faz impreso te sale $X, o $Y si lo querés con anillado").
6. DERIVAR A LA WEB (PRIORIDAD): Tu objetivo principal es que el cliente cierre su pedido usando nuestra web (https://buenplan.topcopiasok.workers.dev/alumnos). Ofrécela SIEMPRE como la primera opción. Solo si el cliente prefiere o insiste en encargar el trabajo directamente por WhatsApp, procede así: 1) Pasa el presupuesto. 2) Pide que confirme con nombre y apellido. 3) Sugiere pagar en el alias (no es obligatorio). 4) Informa que estará listo en la fecha de entrega estimada.
7. TRABAJOS COMPLEJOS: Intenta resolver o recolectar todos los detalles del trabajo (tamaño, cantidad, tipo de papel). Trata de ayudar todo lo que puedas sin rendirte fácilmente. Solo si el cliente exige hablar con un humano o el trabajo es imposible de cotizar, dile EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad."
8. BUSCAR EN CATÁLOGO: Si un estudiante busca su módulo o apunte, búscalo en el "CATÁLOGO DE APUNTES DISPONIBLES" en tu memoria. Ahí tienes toda la info de los profesores y precios para tomarle el pedido.
9. NO DES DETALLES INNECESARIOS: Sé directo.

HORARIOS Y DIRECCIÓN DEL LOCAL FÍSICO:
- Dirección: Av 3 N 1406 (Altura 114), sobre Av 3, al lado de la quiniela (el local no tiene carteles).
- Lunes a Jueves: 9:00 a 12:00 hs y de 17:30 a 19:00 hs.
- Viernes: 9:00 a 12:30 hs (Cerrado por la tarde).
- Sábados y Domingos: Cerrado.

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
            console.log("Si el QR de abajo se ve mal, HAZ CLIC EN ESTE ENLACE PARA VERLO COMO IMAGEN:");
            console.log("https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" + encodeURIComponent(qr));
            console.log("\n");
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

            // Detectar si mandó un archivo (Documento, Imagen o Audio) sin necesidad de descargarlo
            const docMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
            const imgMessage = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
            const audioMessage = msg.message.audioMessage;

            if (audioMessage) {
                textMessage = `[EL CLIENTE ACABA DE ENVIAR UN AUDIO. Tú NO puedes escuchar audios. Pídele amablemente que por favor escriba su consulta por texto.]`;
            } else if (docMessage) {
                const pages = docMessage.pageCount;
                if (pages && pages > 0) {
                    textMessage = `[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO PDF DE ${pages} PÁGINAS. Calcula el precio total asumiendo impresión en Blanco y Negro, Simple Faz en A4] ` + (textMessage || "¿Cuánto sale imprimir esto?");
                } else {
                    textMessage = `[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO pero el sistema no puede leer cuántas páginas tiene. Pídele amablemente que lo suba a la web para cotizarlo correctamente] ` + (textMessage || "¿Cuánto sale imprimir esto?");
                }
            } else if (imgMessage) {
                textMessage = `[EL CLIENTE ACABA DE ENVIAR 1 IMAGEN. Calcula el precio por 1 carilla A Color y luego derívalo a la web] ` + (textMessage || "¿Cuánto sale imprimir esto?");
            }

            if (textMessage) {
                const queue = messageQueues.get(senderNumber) || { text: "", timer: null };
                
                if (queue.text !== "") {
                    queue.text += "\n" + textMessage;
                } else {
                    queue.text = textMessage;
                }

                if (queue.timer) clearTimeout(queue.timer);

                queue.timer = setTimeout(async () => {
                    const finalMessage = queue.text;
                    messageQueues.delete(senderNumber);
                    
                    console.log(`\n💬 Procesando consulta consolidada de ${senderNumber.split('@')[0]}`);
                    try {
                        await sock.sendPresenceUpdate('composing', senderNumber);

                        // Recuperar o iniciar el historial
                        let userHistory = chatHistories.get(senderNumber) || [];
                        userHistory.push({ role: "user", parts: [{ text: finalMessage }] });
                        
                        // Mantener solo los últimos 6 mensajes (3 idas y vueltas) para no gastar de más
                        if (userHistory.length > 6) userHistory = userHistory.slice(userHistory.length - 6);

                        const model = genAI.getGenerativeModel({ 
                            model: "gemini-flash-latest",
                            systemInstruction: BASE_PROMPT + dynamicContext
                        });
                        
                        const result = await model.generateContent({ contents: userHistory });
                        const aiResponseText = result.response.text();

                        // Guardar la respuesta del bot en el historial
                        userHistory.push({ role: "model", parts: [{ text: aiResponseText }] });
                        chatHistories.set(senderNumber, userHistory);

                        await sock.sendMessage(senderNumber, { text: aiResponseText });
                        console.log(`🤖 Respuesta enviada.`);
                        
                        if (aiResponseText.includes("integrante del equipo te atenderá")) {
                            mutedUsers.set(senderNumber, Date.now());
                            console.log(`[DERIVACIÓN] 👤 Bot silenciado para ${senderNumber.split('@')[0]}.`);
                            
                            // Enviarse un mensaje de alerta a sí mismo (al número del bot)
                            try {
                                const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                                await sock.sendMessage(botNumber, { 
                                    text: `⚠️ *ALERTA DE ATENCIÓN* ⚠️\nEl cliente wa.me/${senderNumber.split('@')[0]} requiere intervención humana.\nÚltimo mensaje consolidado del cliente:\n"${finalMessage}"` 
                                });
                            } catch (e) {
                                console.log("No se pudo enviar la alerta al propio bot.");
                            }
                        }

                        await sock.sendPresenceUpdate('paused', senderNumber);
                    } catch (error) {
                        console.error("❌ Error al generar respuesta:", error.message);
                    }
                }, DEBOUNCE_TIME);
                
                messageQueues.set(senderNumber, queue);
            }
        }
    })
}

initFirebase().then(() => {
    connectToWhatsApp();
});
