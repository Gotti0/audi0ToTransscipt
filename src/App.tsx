import React, { useState, useRef } from "react";
import { Upload, FileAudio, Download, Settings, Loader2, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { GoogleGenAI, Type } from "@google/genai";
import { chunkAudio } from "./utils/audioChunker";
import { Subtitle, jsonToSrt, downloadSrt } from "./utils/srtConverter";
import { RateLimiter, processWithConcurrency } from "./utils/rateLimiter";

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(",")[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("Korean");
  const [chunkSize, setChunkSize] = useState(30); // in seconds
  const [maxWorkers, setMaxWorkers] = useState(3);
  const [rpm, setRpm] = useState(15);
  const [isProcessing, setIsProcessing] = useState(false);
  const [availableModels] = useState<{name: string, displayName: string}[]>([
    { name: "gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview" },
    { name: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview" },
    { name: "gemini-3.1-flash-lite-preview", displayName: "Gemini 3.1 Flash Lite Preview" },
  ]);
  const [selectedModel, setSelectedModel] = useState("gemini-3-flash-preview");
  const [progress, setProgress] = useState(0);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  
  // State for retry logic
  const [audioChunks, setAudioChunks] = useState<any[]>([]);
  const [failedIndices, setFailedIndices] = useState<number[]>([]);
  const allSubtitlesRef = useRef<Subtitle[][]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsPerPage = 10;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setSubtitles([]);
      setProgress(0);
      setError(null);
      setFailedIndices([]);
      setAudioChunks([]);
      allSubtitlesRef.current = [];
    }
  };

  const processSpecificChunks = async (chunksToProcess: { chunk: any; originalIndex: number }[]) => {
    setIsProcessing(true);
    setError(null);
    // Do not clear failedIndices here, we will merge them later

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API 키가 설정되지 않았습니다. 설정 메뉴에서 확인해주세요.");
      }

      const ai = new GoogleGenAI({ apiKey });
      const rateLimiter = new RateLimiter(rpm);
      
      const totalToProcess = chunksToProcess.length;
      let completedInThisRun = 0;
      const currentFailed: number[] = [];

      await processWithConcurrency(chunksToProcess, maxWorkers, async ({ chunk, originalIndex }) => {
        await rateLimiter.wait();

        try {
          const base64Audio = await blobToBase64(chunk.blob);

          const response = await ai.models.generateContent({
            model: selectedModel,
            contents: {
              parts: [
                {
                  inlineData: {
                    data: base64Audio,
                    mimeType: "audio/wav",
                  },
                },
                {
                  text: `Transcribe the following audio in ${language}. The audio segment starts at ${chunk.startTime} seconds and ends at ${chunk.endTime} seconds. Provide the subtitles with accurate timestamps relative to the original audio. The startTime and endTime of each subtitle should be in the format "HH:MM:SS,mmm".`,
                },
              ],
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  subtitles: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        startTime: {
                          type: Type.STRING,
                          description: "Start time in HH:MM:SS,mmm format",
                        },
                        endTime: {
                          type: Type.STRING,
                          description: "End time in HH:MM:SS,mmm format",
                        },
                        text: {
                          type: Type.STRING,
                          description: "Transcribed text",
                        },
                      },
                      required: ["startTime", "endTime", "text"],
                    },
                  },
                },
                required: ["subtitles"],
              },
            },
          });

          const text = response.text;
          if (!text) {
            throw new Error(`${originalIndex + 1}번째 청크에서 응답을 받지 못했습니다.`);
          }

          const data = JSON.parse(text);
          if (data.subtitles && Array.isArray(data.subtitles)) {
            allSubtitlesRef.current[originalIndex] = data.subtitles;
            setSubtitles(allSubtitlesRef.current.flat().filter(Boolean));
          } else {
            throw new Error("Invalid format");
          }
        } catch (err) {
          console.error(`Chunk ${originalIndex} failed:`, err);
          currentFailed.push(originalIndex);
        } finally {
          completedInThisRun++;
          // Update progress relative to the current batch being processed
          setProgress(10 + (completedInThisRun / totalToProcess) * 90);
        }
      });

      setFailedIndices(prev => {
        const newFailed = new Set(prev);
        chunksToProcess.forEach(c => newFailed.delete(c.originalIndex));
        currentFailed.forEach(idx => newFailed.add(idx));
        return Array.from(newFailed);
      });
      
      if (currentFailed.length > 0) {
        setError(`일부 청크 처리에 실패했습니다. 재시도 버튼을 눌러주세요.`);
      } else {
        setProgress(100);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "처리 중 오류가 발생했습니다.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProcess = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress(0);
    setSubtitles([]);
    setError(null);
    setFailedIndices([]);

    try {
      // 1. Chunk Audio
      const chunks = await chunkAudio(file, chunkSize, (p) => {
        setProgress(p * 10);
      });
      
      setAudioChunks(chunks);
      allSubtitlesRef.current = new Array(chunks.length).fill([]);

      // 2. Process each chunk concurrently
      const chunksToProcess = chunks.map((chunk, index) => ({ chunk, originalIndex: index }));
      await processSpecificChunks(chunksToProcess);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "오디오 분할 중 오류가 발생했습니다.");
      setIsProcessing(false);
    }
  };

  const handleRetry = async () => {
    if (failedIndices.length === 0 || audioChunks.length === 0) return;
    
    const chunksToProcess = failedIndices.map(index => ({
      chunk: audioChunks[index],
      originalIndex: index
    }));
    
    setProgress(10); // Start at 10% since chunking is already done
    await processSpecificChunks(chunksToProcess);
  };

  const handleRetrySingleChunk = async (index: number) => {
    if (audioChunks.length === 0 || !audioChunks[index]) return;
    setProgress(10);
    await processSpecificChunks([{ chunk: audioChunks[index], originalIndex: index }]);
  };

  const handleDownload = () => {
    if (subtitles.length === 0) return;
    const srtContent = jsonToSrt(subtitles);
    downloadSrt(srtContent, `${file?.name || "audio"}_subtitles.srt`);
  };

  // Pagination logic
  const totalPages = Math.ceil(subtitles.length / itemsPerPage);
  const currentSubtitles = subtitles.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileAudio className="w-6 h-6 text-indigo-600" />
            <h1 className="text-xl font-semibold tracking-tight">오디오 자막 추출기</h1>
          </div>
          {subtitles.length > 0 && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 rounded-lg font-medium hover:bg-indigo-100 transition-colors text-sm"
            >
              <Download className="w-4 h-4" />
              SRT 다운로드
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Settings & Upload Card */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Upload Area */}
            <div className="space-y-4">
              <h2 className="text-lg font-medium flex items-center gap-2">
                <Upload className="w-5 h-5 text-slate-500" />
                오디오 업로드
              </h2>
              <div
                className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:bg-slate-50 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="audio/*"
                  className="hidden"
                />
                <div className="flex flex-col items-center gap-2">
                  <div className="p-3 bg-indigo-50 rounded-full text-indigo-600">
                    <FileAudio className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-medium text-slate-700">
                    {file ? file.name : "클릭하여 오디오 파일 선택"}
                  </p>
                  <p className="text-xs text-slate-500">최대 50MB의 MP3, WAV, M4A 파일</p>
                </div>
              </div>
            </div>

            {/* Settings Area */}
            <div className="space-y-4">
              <h2 className="text-lg font-medium flex items-center gap-2">
                <Settings className="w-5 h-5 text-slate-500" />
                설정
              </h2>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">AI 모델</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    disabled={isProcessing || availableModels.length === 0}
                  >
                    {availableModels.length === 0 ? (
                      <option value="gemini-3-flash-preview">Gemini 3 Flash Preview</option>
                    ) : (
                      availableModels.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.displayName}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">번역 언어</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    disabled={isProcessing}
                  >
                    <option value="Korean">한국어</option>
                    <option value="English">영어</option>
                    <option value="Japanese">일본어</option>
                    <option value="Spanish">스페인어</option>
                    <option value="French">프랑스어</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-slate-700">청크 크기 (초)</label>
                  <input
                    type="number"
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Number(e.target.value))}
                    min={10}
                    max={300}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    disabled={isProcessing}
                  />
                  <p className="text-xs text-slate-500">청크 크기가 클수록 처리 시간은 길어지지만 문맥을 더 잘 파악합니다.</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">최대 동시 작업자 수</label>
                    <input
                      type="number"
                      value={maxWorkers}
                      onChange={(e) => setMaxWorkers(Number(e.target.value))}
                      min={1}
                      max={10}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                      disabled={isProcessing}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">분당 최대 요청 수 (RPM)</label>
                    <input
                      type="number"
                      value={rpm}
                      onChange={(e) => setRpm(Number(e.target.value))}
                      min={1}
                      max={60}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                      disabled={isProcessing}
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 space-y-3">
                <button
                  onClick={handleProcess}
                  disabled={!file || isProcessing}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      처리 중...
                    </>
                  ) : (
                    "자막 추출 시작"
                  )}
                </button>

                {failedIndices.length > 0 && !isProcessing && (
                  <button
                    onClick={handleRetry}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600 transition-colors"
                  >
                    <RefreshCw className="w-5 h-5" />
                    실패한 {failedIndices.length}개 청크 재시도
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          {(isProcessing || progress > 0) && (
            <div className="mt-8 space-y-2">
              <div className="flex justify-between text-sm font-medium text-slate-700">
                <span>진행률</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm border border-red-100">
              {error}
            </div>
          )}
        </section>

        {/* Chunk Management Section */}
        {audioChunks.length > 0 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-2">
              <h2 className="text-lg font-medium text-slate-800">청크별 상태 및 개별 재시도</h2>
              <span className="text-xs text-slate-500">출력이 잘렸거나 누락된 구간을 수동으로 재시도할 수 있습니다.</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 max-h-64 overflow-y-auto p-1">
              {audioChunks.map((chunk, idx) => {
                const isFailed = failedIndices.includes(idx);
                const subCount = allSubtitlesRef.current[idx]?.length || 0;
                return (
                  <div key={idx} className={`p-3 rounded-xl border ${isFailed ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50'} flex flex-col justify-between`}>
                    <div>
                      <div className="text-sm font-bold text-slate-700 mb-1">청크 {idx + 1}</div>
                      <div className="text-xs text-slate-500 mb-2">{chunk.startTime}s ~ {chunk.endTime}s</div>
                      <div className={`text-xs font-medium mb-3 ${subCount === 0 ? 'text-amber-600' : 'text-indigo-600'}`}>
                        자막 {subCount}줄
                      </div>
                    </div>
                    <button
                      onClick={() => handleRetrySingleChunk(idx)}
                      disabled={isProcessing}
                      className="w-full py-1.5 px-2 bg-white border border-slate-300 rounded-lg text-xs font-medium hover:bg-slate-100 disabled:opacity-50 transition-colors flex items-center justify-center gap-1 mt-2"
                    >
                      <RefreshCw className="w-3 h-3" />
                      재시도
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Results Section */}
        {subtitles.length > 0 && (
          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
              <h2 className="font-medium text-slate-800">생성된 자막</h2>
              <span className="text-xs font-medium px-2.5 py-1 bg-indigo-100 text-indigo-700 rounded-full">
                총 {subtitles.length}개
              </span>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 w-24">#</th>
                    <th className="px-6 py-3 w-48">시간</th>
                    <th className="px-6 py-3">텍스트</th>
                  </tr>
                </thead>
                <tbody>
                  {currentSubtitles.map((sub, idx) => {
                    const globalIdx = (currentPage - 1) * itemsPerPage + idx + 1;
                    return (
                      <tr key={globalIdx} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="px-6 py-4 font-medium text-slate-500">{globalIdx}</td>
                        <td className="px-6 py-4 font-mono text-xs text-slate-600">
                          {sub.startTime} <br />
                          <span className="text-slate-400">~</span> <br />
                          {sub.endTime}
                        </td>
                        <td className="px-6 py-4 text-slate-800">{sub.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between">
                <span className="text-sm text-slate-500">
                  총 <span className="font-medium">{subtitles.length}</span>개 중{" "}
                  <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> ~{" "}
                  <span className="font-medium">
                    {Math.min(currentPage * itemsPerPage, subtitles.length)}
                  </span>번째 항목 표시 중
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="p-1 rounded-md hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed text-slate-600"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <span className="text-sm font-medium text-slate-700">
                    {currentPage} / {totalPages} 페이지
                  </span>
                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1 rounded-md hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed text-slate-600"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
