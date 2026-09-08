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
const userModes = new Map();
const botMessageIds = new Set();
const botReplyCounts = new Map(); // Para limitar a 5 mensajes por sesión
let botAwake = true; // Variable para dormir o despertar al bot
const OWNER_NUMBERS = ['22674418815', '2255556502']; // Números autorizados para comandos
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

const PROMPT_IMPRESIONES = `Eres el asistente virtual de "Buen Plan", papelería y centro de copiado.
Trata al cliente de "vos", de forma amable y servicial. Estás en el MODO IMPRESIONES.

REGLAS ESTRICTAS DE RESPUESTA:
0. BREVEDAD: Tus respuestas deben ser SIEMPRE MUY CORTAS y precisas. No des explicaciones largas.
1. ENFOQUE EXCLUSIVO: Tu único trabajo aquí es cotizar impresiones, fotocopias y apuntes.
2. PROHIBICIÓN DE AGENDAS: BAJO NINGÚN CONCEPTO ofrezcas ni hables de agendas, cuadernos, souvenires, ni des la web buenplan.ar a menos que el cliente pregunte explícitamente ("vi que hacen agendas"). Si te preguntan, diles que deben elegir la opción 2 del menú inicial o derívalos.
3. COTIZACIÓN DE IMPRESIONES: Si el cliente pregunta cuánto cuesta imprimir, asume SIEMPRE que es en Blanco y Negro y dale solo ese precio. NO menciones opciones a Color a menos que el cliente use la palabra "color" explícitamente. Aclara que de todas maneras una persona revisará y confirmará el presupuesto final ya que puede haber algún detalle no tenido en cuenta.
4. ARCHIVOS RECIBIDOS Y PRESUPUESTO TOTAL:
   - El sistema te dará una pista invisible sobre la cantidad de páginas.
   - Suma SIEMPRE el total de todos los archivos enviados en la charla para darle el costo total.
5. REGLA DEL ANILLADO: NUNCA des detalles de cómo se calcula. Dales el precio final. Solo ofrécelo si tiene MÁS de 40 páginas.
6. DERIVAR A LA WEB DE ALUMNOS (PRIORIDAD): Tu objetivo es que cierren el pedido en https://buenplan.topcopiasok.workers.dev/alumnos. Disuade el pedido por WhatsApp.
7. CERRAR VENTAS POR WHATSAPP (SEÑA): SOLO si insisten por WhatsApp: 1) Pasa presupuesto. 2) Pide nombre. 3) Informa que es OBLIGATORIO abonar seña del 50% al alias. 4) Informa fecha de entrega.
8. MÓDULOS DE PROFESORES: No uses el catálogo para venderlos por WhatsApp. Derívalo DIRECTAMENTE a la web de alumnos.
9. HOJAS VS PÁGINAS: Si pide precio para "hojas" físicas, calcula el doble de páginas. Si dice "páginas", toma el número tal cual.
10. DERIVACIÓN: Si exigen humano o se quejan de la seña, di EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad."
11. SEGUIMIENTO DE PEDIDOS: Si envían comprobantes o preguntan por pedidos listos, di EXACTAMENTE: "Un integrante del equipo revisará tu pedido y te responderá a la brevedad."
12. NO DES DETALLES INNECESARIOS: Sé directo.

HORARIOS Y DIRECCIÓN DEL LOCAL FÍSICO:
- ¡ANUNCIO IMPORTANTE! El día Lunes 7/9/2026 el local permanecerá CERRADO.
- Dirección: Av 3 N 1406 (Altura 114), sobre Av 3, al lado de la quiniela.
- Lunes a Jueves: 9:00 a 12:00 hs y 17:30 a 19:00 hs.
- Viernes: 9:00 a 12:30 hs (Cerrado por la tarde).
- Sábados y Domingos: Cerrado.

INFORMACIÓN EN TIEMPO REAL:
`;

const PROMPT_BUENPLAN = `Eres el asistente virtual de "Buen Plan".
Trata al cliente de "vos", de forma amable y servicial. Estás en el MODO AGENDAS Y SOUVENIRES.

REGLAS ESTRICTAS DE RESPUESTA:
0. BREVEDAD: Tus respuestas deben ser SIEMPRE MUY CORTAS y precisas. No des explicaciones largas.
1. ENFOQUE EXCLUSIVO: Tu único trabajo aquí es asesorar sobre agendas, cuadernos de diseño, libretas, souvenires y regalos.
2. PROHIBICIÓN DE IMPRESIONES: BAJO NINGÚN CONCEPTO ofrezcas, cotices ni hables de fotocopias, impresiones o apuntes, ni des la web de alumnos. Si preguntan por impresiones, diles que deben elegir la opción 1 del menú inicial o derívalos.
3. PRODUCTOS PERSONALIZADOS: Deriva TODO a https://buenplan.ar (allí están los precios, plazos y envío).
4. COORDINACIÓN: Aclará brevemente que una vez hecha la compra por la web, nos comunicamos por WhatsApp para coordinar el diseño personalizado.
5. DETALLES (SÓLO SI PREGUNTAN):
   - Libritos (10x15) y grandes (21x15): Tapa foto/ilustración full color, 12 págs colorear, personalizados.
   - Revistas (21x15): Tapa papel obra full color, 12 págs colorear.
   - Diseños: 2 distintos c/60 unidades (personalizados) o 4 c/100.
6. DERIVACIÓN: Si piden más modelos, exigen un humano, envían un comprobante de pago o reclaman un pedido, di EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad."

HORARIOS Y DIRECCIÓN DEL LOCAL FÍSICO:
- Dirección: Av 3 N 1406 (Altura 114), sobre Av 3, al lado de la quiniela.
- Lunes a Jueves: 9:00 a 12:00 hs y 17:30 a 19:00 hs.
- Viernes: 9:00 a 12:30 hs (Cerrado por la tarde).
- Sábados y Domingos: Cerrado.
`;

const PROMPT_ROUTER = `Eres el recepcionista de "Buen Plan" (papelería, fotocopias y venta de agendas/cuadernos).
Tu objetivo es leer la conversación del cliente y determinar qué servicio busca.

REGLAS ESTRICTAS:
1. Si el cliente busca fotocopias, impresiones, imprimir, anillados, o apuntes (o responde con "1", "la primera"), DEBES responder ÚNICAMENTE con la palabra clave: [ROUTER_IMPRESIONES]
2. Si el cliente busca agendas, libretas, cuadernos, souvenires o regalos (o responde con "2", "la segunda"), DEBES responder ÚNICAMENTE con la palabra clave: [ROUTER_AGENDAS]
3. Si el cliente solo dice "Hola", "Buen día" o su mensaje no deja claro qué servicio de los dos quiere, salúdalo amablemente (de forma humana y natural, no estructurada). Pregúntale en qué lo puedes ayudar hoy, dándole a elegir entre el sector de "Impresiones y Apuntes" o el sector de "Agendas y Cuadernos". NO ofrezcas otros servicios ni des catálogos aquí.
`;

function isBusinessHours() {
    const formatter = new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'long',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    
    const parts = formatter.formatToParts(new Date());
    let weekday = '', hour = 0, minute = 0;
    
    for (const part of parts) {
        if (part.type === 'weekday') weekday = part.value.toLowerCase();
        if (part.type === 'hour') hour = parseInt(part.value, 10);
        if (part.type === 'minute') minute = parseInt(part.value, 10);
    }
    
    const timeInMinutes = hour * 60 + minute;
    
    if (['lunes', 'martes', 'miércoles', 'miercoles', 'jueves'].includes(weekday)) {
        if (timeInMinutes >= 540 && timeInMinutes < 720) return true; // 9:00 a 12:00
        if (timeInMinutes >= 1050 && timeInMinutes < 1140) return true; // 17:30 a 19:00
    }
    
    if (weekday === 'viernes') {
        if (timeInMinutes >= 540 && timeInMinutes < 750) return true; // 9:00 a 12:30
    }
    
    return false;
}

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        keepAliveIntervalMs: 15000,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('connection.update', async (update) => {
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
            const fromMe = msg.key.fromMe || false;
            const isOwnerTesting = OWNER_NUMBERS.some(num => senderNumber.includes(num)) || fromMe;

            let textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            // Lógica para prender o apagar el bot
            if (isOwnerTesting) {
                const commandText = textMessage.trim().toLowerCase();
                if (commandText === 'desactivar') {
                    botAwake = false;
                    await sock.sendMessage(senderNumber, { text: "💤 Bot desactivado. No responderé más mensajes hasta que envíes 'activar'." });
                    continue;
                } else if (commandText === 'activar') {
                    botAwake = true;
                    await sock.sendMessage(senderNumber, { text: "🚀 Bot activado. Vuelvo a estar operativo." });
                    continue;
                }
            }

            // Si el bot está dormido, no procesamos nada (salvo los comandos de arriba que ya se ejecutaron)
            if (!botAwake) return;

            if (msg.key.fromMe) {
                if (botMessageIds.has(msg.key.id)) {
                    botMessageIds.delete(msg.key.id);
                    continue;
                }
                if (!senderNumber.includes('@g.us') && senderNumber !== 'status@broadcast') {
                    mutedUsers.set(senderNumber, Date.now());
                    console.log(`\n[MUTE] 🤐 Le respondiste a ${senderNumber.split('@')[0]}. Bot silenciado por 12 horas.`);
                }
                continue;
            }

            if (senderNumber.includes('@g.us') || senderNumber === 'status@broadcast') continue;

            if (mutedUsers.has(senderNumber) && !isOwnerTesting) {
                if (Date.now() - mutedUsers.get(senderNumber) < ONE_HOUR) {
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

                if (userStats.count > 100) {
                    if (userStats.count === 101) {
                        await sock.sendMessage(senderNumber, { text: "Has realizado demasiadas consultas seguidas. Un integrante del equipo te atenderá de forma personalizada a la brevedad." });
                        mutedUsers.set(senderNumber, Date.now()); 
                    }
                    continue;
                }
            }
            textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            // Detectar si mandó un archivo (Documento, Imagen o Audio) sin necesidad de descargarlo
            const docMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
            const imgMessage = msg.message.imageMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
            const audioMessage = msg.message.audioMessage;

            if (audioMessage) {
                textMessage = `[EL CLIENTE ACABA DE ENVIAR UN AUDIO. Tú NO puedes escuchar audios. Pídele amablemente que por favor escriba su consulta por texto.]`;
            } else if (docMessage) {
                const pages = docMessage.pageCount;
                if (pages && pages > 2) {
                    textMessage = `[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO PDF DE ${pages} PÁGINAS. Si crees que es un comprobante de pago, NO lo cotices. Si es para imprimir, calcula el precio asumiendo impresión en Blanco y Negro, Doble Faz en A4] ` + (textMessage || "");
                } else if (pages && pages > 0) {
                    textMessage = `[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO PDF DE ${pages} PÁGINAS. Si crees que es un comprobante de pago, NO lo cotices. Si es para imprimir, calcula el precio asumiendo impresión en Blanco y Negro, Simple Faz en A4] ` + (textMessage || "");
                } else {
                    textMessage = `[EL CLIENTE ACABA DE ENVIAR UN ARCHIVO. Si es un comprobante de pago, avisa que será revisado. Si es para imprimir, dile que el sistema no puede leer cuántas páginas tiene y pídele amablemente que lo suba a la web] ` + (textMessage || "");
                }
            } else if (imgMessage) {
                textMessage = `[EL CLIENTE ACABA DE ENVIAR 1 IMAGEN. Si parece un COMPROBANTE DE PAGO, NO lo cotices y avisa que un integrante lo revisará. Si parece una imagen para imprimir, calcula el precio por 1 carilla A Color y derívalo a la web] ` + (textMessage || "");
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
                    
                    let modeData = userModes.get(senderNumber);
                    if (!modeData || (Date.now() - modeData.timestamp > ONE_HOUR)) {
                        modeData = { mode: 'PENDING', timestamp: Date.now() };
                        userModes.set(senderNumber, modeData);
                        chatHistories.set(senderNumber, []);
                    }

                    if (modeData.mode === 'PENDING') {
                        let userHistory = chatHistories.get(senderNumber) || [];
                        userHistory.push({ role: "user", parts: [{ text: finalMessage }] });
                        
                        const routerModel = genAI.getGenerativeModel({ 
                            model: "gemini-flash-latest",
                            systemInstruction: PROMPT_ROUTER
                        });
                        
                        try {
                            await sock.sendPresenceUpdate('composing', senderNumber);
                            const result = await routerModel.generateContent({ contents: userHistory });
                            const routerResponse = result.response.text().trim();

                            if (routerResponse.includes('[ROUTER_IMPRESIONES]')) {
                                modeData.mode = 'IMPRESIONES';
                                modeData.timestamp = Date.now();
                                userModes.set(senderNumber, modeData);
                                userHistory.pop(); // Remove it to add it again in the main flow
                            } else if (routerResponse.includes('[ROUTER_AGENDAS]')) {
                                modeData.mode = 'BUENPLAN';
                                modeData.timestamp = Date.now();
                                userModes.set(senderNumber, modeData);
                                userHistory.pop(); // Remove it to add it again in the main flow
                            } else {
                                userHistory.push({ role: "model", parts: [{ text: routerResponse }] });
                                chatHistories.set(senderNumber, userHistory);
                                
                                const sentMsg = await sock.sendMessage(senderNumber, { text: routerResponse });
                                if (sentMsg) botMessageIds.add(sentMsg.key.id);
                                await sock.sendPresenceUpdate('paused', senderNumber);
                                
                                let replyStats = botReplyCounts.get(senderNumber) || { count: 0, timestamp: Date.now() };
                                if (Date.now() - replyStats.timestamp > TWELVE_HOURS) { replyStats.count = 0; replyStats.timestamp = Date.now(); }
                                replyStats.count += 1;
                                botReplyCounts.set(senderNumber, replyStats);
                                
                                return;
                            }
                        } catch (e) {
                            console.error("Error en router:", e);
                            await sock.sendPresenceUpdate('paused', senderNumber);
                            return;
                        }
                    } else {
                        modeData.timestamp = Date.now();
                        userModes.set(senderNumber, modeData);
                    }
                    try {
                        let replyStats = botReplyCounts.get(senderNumber) || { count: 0, timestamp: Date.now() };
                        if (Date.now() - replyStats.timestamp > TWELVE_HOURS) {
                            replyStats.count = 0;
                            replyStats.timestamp = Date.now();
                        }

                        if (replyStats.count >= 5) {
                            const finalMsg = "Un integrante del equipo revisará tu pedido y te responderá a la brevedad.";
                            const sentMsg = await sock.sendMessage(senderNumber, { text: finalMsg });
                            if (sentMsg) botMessageIds.add(sentMsg.key.id);
                            
                            mutedUsers.set(senderNumber, Date.now());
                            console.log(`[LÍMITE ALCANZADO] 👤 5 mensajes enviados. Bot silenciado por 12hs para ${senderNumber.split('@')[0]}.`);
                            
                            try {
                                const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                                await sock.sendMessage(botNumber, { 
                                    text: `⚠️ *ALERTA DE ATENCIÓN (Límite 5 msgs)* ⚠️\nEl cliente wa.me/${senderNumber.split('@')[0]} requiere intervención humana.\nÚltimo mensaje:\n"${finalMessage}"` 
                                });
                            } catch (e) {}
                            
                            return;
                        }

                        replyStats.count += 1;
                        botReplyCounts.set(senderNumber, replyStats);

                        await sock.sendPresenceUpdate('composing', senderNumber);

                        // Recuperar o iniciar el historial
                        let userHistory = chatHistories.get(senderNumber) || [];
                        userHistory.push({ role: "user", parts: [{ text: finalMessage }] });
                        
                        // NOTA: Se ha removido el límite de historial (antes 6 mensajes)
                        // para permitir que la IA sume archivos enviados en largas tandas.

                        let sysPrompt = modeData.mode === 'IMPRESIONES' ? (PROMPT_IMPRESIONES + dynamicContext) : PROMPT_BUENPLAN;

                        const model = genAI.getGenerativeModel({ 
                            model: "gemini-flash-latest",
                            systemInstruction: sysPrompt
                        });
                        
                        const result = await model.generateContent({ contents: userHistory });
                        const aiResponseText = result.response.text();

                        // Guardar la respuesta del bot en el historial
                        userHistory.push({ role: "model", parts: [{ text: aiResponseText }] });
                        chatHistories.set(senderNumber, userHistory);

                        const sentMsg = await sock.sendMessage(senderNumber, { text: aiResponseText });
                        if (sentMsg) botMessageIds.add(sentMsg.key.id);
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
