/**
 * Tests de `chunkText` — puro y sin dependencias, así que cubre boundaries
 * exactos aparte del caso feliz.
 *
 *   pnpm --filter @hermes/agent test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS } from "./chunk.js";

test("happy path: texto corto vuelve como un solo fragmento", () => {
  const pieces = chunkText("hola mundo");
  assert.deepEqual(pieces, ["hola mundo"]);
});

test("happy path: texto largo se trocea con solape entre fragmentos consecutivos", () => {
  const text = "a".repeat(6500);
  const pieces = chunkText(text, 6000, 300);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].length, 6000);
  // El segundo fragmento arranca 300 chars antes del final del primero.
  assert.equal(pieces[1], text.slice(5700));
  // Reconstruyendo sin el solape se recupera el texto completo.
  assert.equal(pieces[0] + pieces[1].slice(300), text);
});

test("edge: string vacío devuelve sin fragmentos", () => {
  assert.deepEqual(chunkText(""), []);
});

test("edge: string de solo espacios/whitespace se trata como vacío", () => {
  assert.deepEqual(chunkText("   \n\t  "), []);
});

test("edge: recorta espacios sobrantes del único fragmento", () => {
  assert.deepEqual(chunkText("  hola  "), ["hola"]);
});

test("edge: longitud EXACTA al tamaño de chunk no genera un segundo fragmento vacío", () => {
  const text = "x".repeat(6000);
  const pieces = chunkText(text, 6000, 300);
  assert.deepEqual(pieces, [text]);
});

test("edge: un char más que el tamaño de chunk sí genera un segundo fragmento", () => {
  const text = "x".repeat(6001);
  const pieces = chunkText(text, 6000, 300);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].length, 6000);
  assert.equal(pieces[1].length, 301); // el char 6001 + los 300 de solape
});

test("edge: overlap >= chunkSize no deja el loop colgado (progresa igual)", () => {
  const text = "y".repeat(1000);
  // Con overlap == chunkSize, `start = end - overlap` puede no avanzar si no
  // hay tope; verificamos que termina y no entra en loop infinito.
  const pieces = chunkText(text, 100, 100);
  assert.ok(pieces.length > 0);
  assert.ok(pieces.length < 1000); // no quedó atascado generando miles de copias
});

test("edge: overlap 0 no repite contenido entre fragmentos", () => {
  const text = "0123456789".repeat(150); // 1500 chars
  const pieces = chunkText(text, 500, 0);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.join(""), text);
});

test("edge: caracteres multi-byte (emoji/acentos) no rompen el conteo de longitud", () => {
  const text = "café con ñoquis 🎉".repeat(500);
  const pieces = chunkText(text, 6000, 300);
  assert.ok(pieces.length >= 1);
  // Ningún fragmento vacío ni undefined.
  for (const p of pieces) assert.ok(p.length > 0);
});

test("constantes de producción no se movieron sin querer", () => {
  assert.equal(CHUNK_SIZE_CHARS, 6_000);
  assert.equal(CHUNK_OVERLAP_CHARS, 300);
});
