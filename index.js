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
const botMessageIds = new Set();
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

const BASE_PROMPT = `Eres el asistente digital o bot de "Buen Plan", papelería y centro de copiado.
Trata al cliente de "vos", de forma amable y servicial.

REGLAS ESTRICTAS DE RESPUESTA:
1. SALUDOS GENÉRICOS: Si el cliente solo dice "Hola", "Buenas", "Buen día", etc., NO asumas que quiere imprimir ni le des precios. Responde presentándote, por ejemplo: "¡Hola! Soy el asistente digital de Buen Plan, ¿cómo te puedo ayudar?".
2. PRODUCTOS PERSONALIZADOS Y SOUVENIRS (LIBRITOS/REVISTAS PARA COLOREAR): Si preguntan por libritos, revistas personalizadas, souvenirs, colorear, cumpleaños, bautismos, etc., SÉ BREVE. No des detalles de medidas, materiales ni reglas de cantidad a menos que el cliente lo pregunte explícitamente.
  - REGLA PRINCIPAL: Deriva TODO a https://buenplan.ar (allí están los precios, plazos, envío y toda la info). NUNCA pases el link de impresiones (no mezcles los negocios).
  - COORDINACIÓN: Aclará brevemente que una vez hecha la compra por la web, nos comunicamos por WhatsApp o email para coordinar el diseño personalizado.
  - DETALLES (SÓLO SI TE PREGUNTAN ESPECÍFICAMENTE): 
    * Libritos chicos (10x15) y grandes (21x15): Tapa papel foto/ilustración full color, 12 págs para colorear, personalizados, bolsa individual. 
    * Revistas (21x15): Tapa papel obra full color, 12 págs para colorear, bolsa individual.
    * Diseños: Hasta 2 diseños distintos por cada 60 unidades (personalizados) o 4 cada 100 (sin personalizar).
  - EXCEPCIONES: Si piden más modelos o algo diferente, di EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad."
  Si preguntan por agendas o cuadernos de diseño regulares, también derívalos a https://buenplan.ar.
3. COTIZACIÓN DE IMPRESIONES: Si el cliente pregunta cuánto cuesta imprimir, asume SIEMPRE que es en Blanco y Negro y dale solo ese precio. NO menciones, ni ofrezcas, ni des precios de opciones a Color a menos que el cliente use la palabra "color" explícitamente en su mensaje.
4. ARCHIVOS RECIBIDOS Y PRESUPUESTO TOTAL:
   - El sistema te dará una pista invisible sobre la cantidad de páginas de los archivos enviados. Sigue la indicación de esa pista para cotizar (Simple Faz o Doble Faz).
   - IMPORTANTE: Ten memoria de TODOS los archivos y consultas de la conversación actual. Los clientes suelen mandar archivos por tandas. Revisa desde el inicio de la conversación y suma SIEMPRE el total de todos los archivos enviados para darle el costo total definitivo.
5. REGLA DEL ANILLADO: NUNCA des detalles de cómo se calcula el anillado (valor base, extra por hojas, etc). Simplemente dales el precio final. Si el archivo o pedido tiene MENOS de 40 páginas, NO ofrezcas anillarlo a menos que te lo pidan. Si tiene MÁS de 40 páginas, ofrécelo como una opción directa (Ejemplo: "En A4 simple faz impreso te sale $X, o $Y si lo querés con anillado").
6. DERIVAR A LA WEB (PRIORIDAD Y DISUASIÓN): Tu objetivo principal y prioridad absoluta es que el cliente cierre su pedido de impresiones usando nuestra web (https://buenplan.topcopiasok.workers.dev/alumnos). Disuade el pedido por WhatsApp explicando amablemente que por la web es más rápido, automático y directo.
7. CERRAR VENTAS POR WHATSAPP (SEÑA REQUERIDA): SOLO si el cliente insiste en encargar por WhatsApp tras ofrecerle la web, procede así: 
   1) Pasa el presupuesto total de todos los archivos enviados. 
   2) Pide que confirme con nombre y apellido. 
   3) Informa que para confirmar el pedido es OBLIGATORIO abonar una seña del 50% o el pago total al alias proporcionado. Explica amablemente que estamos tomando los pedidos de esta manera porque muchos pedidos previos no fueron retirados.
   4) Informa que estará listo en la fecha de entrega estimada una vez acreditado el pago.
8. DERIVACIÓN POR QUEJAS DE SEÑA: Si el cliente se queja por el pago por adelantado o dice frases como "soy cliente", "siempre retiro y pago en el local", "no quiero hacer seña", etc., NO discutas. Dile EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad." y deriva el chat.
9. TRABAJOS COMPLEJOS: Intenta resolver o recolectar todos los detalles del trabajo. Solo si el cliente exige hablar con un humano o el trabajo es imposible de cotizar, dile EXACTAMENTE: "Un integrante del equipo te atenderá a la brevedad."
10. BUSCAR EN CATÁLOGO: Si un estudiante busca su módulo o apunte, búscalo en el "CATÁLOGO DE APUNTES DISPONIBLES" en tu memoria. Ahí tienes toda la info para tomarle el pedido.
11. SEGUIMIENTO DE PEDIDOS: Si el cliente pregunta por un pedido ya realizado o envía comprobantes de pago de algo ya encargado, NO intentes venderle nada. Dile EXACTAMENTE: "Un integrante del equipo revisará tu pedido y te responderá a la brevedad."
12. HOJAS VS PÁGINAS: Si el cliente pide precio para "hojas" físicas, calcula asumiendo que va impreso de ambos lados (el doble de páginas). Acláralo en tu respuesta para evitar confusiones. Si dice "páginas" o "carillas", toma el número tal cual.
13. NO DES DETALLES INNECESARIOS: Sé directo.

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
            const isOwnerTesting = senderNumber.includes('22674418815'); 

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

                if (userStats.count > 100) {
                    if (userStats.count === 101) {
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
                    try {
                        await sock.sendPresenceUpdate('composing', senderNumber);

                        // Recuperar o iniciar el historial
                        let userHistory = chatHistories.get(senderNumber) || [];
                        userHistory.push({ role: "user", parts: [{ text: finalMessage }] });
                        
                        // NOTA: Se ha removido el límite de historial (antes 6 mensajes)
                        // para permitir que la IA sume archivos enviados en largas tandas.

                        const model = genAI.getGenerativeModel({ 
                            model: "gemini-flash-latest",
                            systemInstruction: BASE_PROMPT + dynamicContext
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
