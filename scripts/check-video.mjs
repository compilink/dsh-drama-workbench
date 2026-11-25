// Usage: node scripts/check-video.mjs /absolute/video.mp4
// Requires npm run build. Exit 2 means technical failure, not approval to publish.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {videoQualityErrors} from '../dist/src/video-pipeline.js';
const path=process.argv[2];if(!path)throw new Error('Supply a local video path');
const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
const before=hash();
const cache=mkdtempSync(join(tmpdir(),'video-swift-cache-'));
const snapshot=join(cache,'probe.mp4');writeFileSync(snapshot,readFileSync(path));
if(createHash('sha256').update(readFileSync(snapshot)).digest('hex')!==before)throw new Error('Input changed before snapshot');
let report;try {report=JSON.parse(execFileSync('swift',['-module-cache-path',cache,fileURLToPath(new URL('./probe-video.swift',import.meta.url)),snapshot],{timeout:180000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).toString());} finally {rmSync(cache,{recursive:true,force:true});}
if(hash()!==before)throw new Error('Video changed during probe');
const errors=videoQualityErrors(report);
console.log(JSON.stringify({sha256:before,report,errors,publishAllowed:false,status:errors.length?'technical_blocked':'awaiting_editorial_and_user_review'},null,2));
if(errors.length)process.exitCode=2;
