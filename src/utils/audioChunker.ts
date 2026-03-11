export async function chunkAudio(
  file: File,
  chunkSizeSeconds: number,
  onProgress?: (progress: number) => void
): Promise<{ blob: Blob; startTime: number; endTime: number }[]> {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  
  // Read file as ArrayBuffer
  const arrayBuffer = await file.arrayBuffer();
  
  // Decode audio data
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  const chunks: { blob: Blob; startTime: number; endTime: number }[] = [];
  const duration = audioBuffer.duration;
  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = audioBuffer.numberOfChannels;
  
  for (let startTime = 0; startTime < duration; startTime += chunkSizeSeconds) {
    const endTime = Math.min(startTime + chunkSizeSeconds, duration);
    const startSample = Math.floor(startTime * sampleRate);
    const endSample = Math.floor(endTime * sampleRate);
    const chunkLength = endSample - startSample;
    
    // Create a new AudioBuffer for the chunk
    const chunkBuffer = audioContext.createBuffer(
      numberOfChannels,
      chunkLength,
      sampleRate
    );
    
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      const chunkData = chunkBuffer.getChannelData(channel);
      chunkData.set(channelData.subarray(startSample, endSample));
    }
    
    // Convert AudioBuffer to WAV Blob
    const wavBlob = audioBufferToWav(chunkBuffer);
    chunks.push({ blob: wavBlob, startTime, endTime });
    
    if (onProgress) {
      onProgress(endTime / duration);
    }
  }
  
  return chunks;
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let offset = 0;
  let pos = 0;

  function writeString(str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
    offset += str.length;
  }

  // write WAVE header
  writeString("RIFF");
  view.setUint32(offset, length - 8, true); offset += 4;
  writeString("WAVE");

  writeString("fmt ");
  view.setUint32(offset, 16, true); offset += 4; // length = 16
  view.setUint16(offset, 1, true); offset += 2; // PCM (uncompressed)
  view.setUint16(offset, numOfChan, true); offset += 2;
  view.setUint32(offset, buffer.sampleRate, true); offset += 4;
  view.setUint32(offset, buffer.sampleRate * 2 * numOfChan, true); offset += 4; // avg. bytes/sec
  view.setUint16(offset, numOfChan * 2, true); offset += 2; // block-align
  view.setUint16(offset, 16, true); offset += 2; // 16-bit (hardcoded in this export)

  writeString("data");
  view.setUint32(offset, length - offset - 4, true); offset += 4; // chunk length

  // write interleaved data
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < buffer.length) {
    for (let i = 0; i < numOfChan; i++) {
      // interleave channels
      let sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(offset, sample, true); // write 16-bit sample
      offset += 2;
    }
    pos++; // next source sample
  }

  return new Blob([bufferArray], { type: "audio/wav" });
}
