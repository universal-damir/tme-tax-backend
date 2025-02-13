import express from 'express';

const app = express();

app.get('/', (req, res) => {
  res.send('Hello, world! Server is live.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Minimal server listening on 0.0.0.0:${PORT}`);
});
