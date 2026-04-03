// Must be the first module evaluated — sets Buffer before Solana libs load
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
