const firebaseConfig = {
    apiKey: "AIzaSyAicuiPj_U-A_MbZGK-YOkwyqENaPOb4zY",
    authDomain: "student-grouping-83e57.firebaseapp.com",
    projectId: "student-grouping-83e57",
    storageBucket: "student-grouping-83e57.firebasestorage.app",
    messagingSenderId: "560603022307",
    appId: "1:560603022307:web:66f21301828cfc5eb096d6",
    measurementId: "G-MNB8L2CHWP"
  };
  
  // Initialize Firebase
firebase.initializeApp(firebaseConfig)

// Initialize Firestore
const db = firebase.firestore()