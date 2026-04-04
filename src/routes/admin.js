const express = require('express');
const path = require('path');

const router = express.Router();

const ADMIN_DIR = path.join(__dirname, '../../admin');

router.get('/products', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'products.html'));
});

router.get('/restock', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'restock.html'));
});

router.get('/movements', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'movements.html'));
});

module.exports = router;
