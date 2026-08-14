const firebase = require('firebase/app');
require('firebase/auth');
require('firebase/database');

const firebaseConfig = {
    apiKey: "AIzaSyD3GgbLx3O_CawX-t1iNaJzQQYLc3OiBB0",
    authDomain: "buen-plan-pos.firebaseapp.com",
    databaseURL: "https://buen-plan-pos-default-rtdb.firebaseio.com",
    projectId: "buen-plan-pos",
    storageBucket: "buen-plan-pos.firebasestorage.app",
    messagingSenderId: "391944185005",
    appId: "1:391944185005:web:f4b60bd09563bbe0789224"
};

firebase.initializeApp(firebaseConfig);

async function test() {
    try {
        console.log("Probando con Piojo0707...");
        await firebase.auth().signInWithEmailAndPassword("tiendabuenplan@gmail.com", "Piojo0707");
        console.log("ÉXITO con Piojo0707!");
        const uid = firebase.auth().currentUser.uid;
        console.log("UID:", uid);
        
        // Try reading data
        const snapshot = await firebase.database().ref(`usuarios/${uid}/buenplan_db`).once('value');
        console.log("Data retrieved:", snapshot.exists());
        
        process.exit(0);
    } catch (e) {
        console.log("Fallo Piojo0707:", e.message);
        process.exit(1);
    }
}

test();
