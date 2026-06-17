#!/bin/bash
cd "$(dirname "$0")"

export PORT=4567
export JWT_SECRET=tmuxremote-sv4-jwt-secret-2026
export FIREBASE_SERVICE_ACCOUNT=/root/projects/tmuxremote/firebase-service-account.json
export FIREBASE_WEB_CONFIG='{"apiKey":"AIzaSyCghpF2PwWK9mDKyuszd1z3vHpdbRT2lqo","authDomain":"remotetmux.firebaseapp.com","projectId":"remotetmux","storageBucket":"remotetmux.firebasestorage.app","messagingSenderId":"37413075438","appId":"1:37413075438:web:5323a8d4cfd6a37345b6ff","measurementId":"G-0QF995JGH0"}'
export EMAIL_WHITELIST=lequanghuylc@gmail.com

exec node server.js
