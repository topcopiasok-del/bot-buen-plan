require('dotenv').config();
const firebase = require('firebase');

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

async function checkDB() {
    await firebase.auth().signInWithEmailAndPassword(process.env.FIREBASE_EMAIL, process.env.FIREBASE_PASSWORD);
    const uid = firebase.auth().currentUser.uid;
    const snapshot = await firebase.database().ref(`usuarios/${uid}/buenplan_db`).once('value');
    const data = snapshot.val();
    
    if (data.apuntes && data.profesores) {
        const apuntes = Object.values(data.apuntes);
        const ap = apuntes[0];
        console.log("Apunte profesorId:", ap.profesorId);
        console.log("data.profesores type:", Array.isArray(data.profesores) ? 'Array' : 'Object');
        console.log("data.profesores[ap.profesorId]:", data.profesores[ap.profesorId]);
        
        // Find it manually just in case
        const profeObj = Object.values(data.profesores).find(p => p.id === ap.profesorId);
        console.log("profeObj via find:", profeObj);
    }
    
    process.exit();
}

checkDB();
