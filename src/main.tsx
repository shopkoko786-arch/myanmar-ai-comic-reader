import React from 'react';
import { createRoot } from 'react-dom/client';
import ComicReader from './ComicReader';
import './reader.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ComicReader /></React.StrictMode>,
);
