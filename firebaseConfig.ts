import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyB9KnXzJaCwX8Az9FtS6HX16cF5ROhNOCk",
  authDomain: "petfind-3fd86.firebaseapp.com",
  projectId: "petfind-3fd86",
  storageBucket: "petfind-3fd86.firebasestorage.app",
  messagingSenderId: "110741259986",
  appId: "1:110741259986:web:bcc2f37cd45620d5478f0b",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);