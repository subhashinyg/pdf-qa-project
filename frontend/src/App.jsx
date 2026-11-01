import { useState, useRef, useEffect } from 'react'
import './App.css'

function App() {
  // Folder & File Navigation State
  const [currentFolder, setCurrentFolder] = useState(null) // null = root
  const [folders, setFolders] = useState([])
  const [files, setFiles] = useState([])
  const [breadcrumbs, setBreadcrumbs] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list'

  // Folder Creation Modal / State
  const [showFolderModal, setShowFolderModal] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // Upload State
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [uploadSuccess, setUploadSuccess] = useState(null)
  const fileInputRef = useRef(null)

  // Selected File Preview State
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewTab, setPreviewTab] = useState('preview') // 'preview' | 'extracted'
  const [isCopied, setIsCopied] = useState(false)

  // AI Q&A State
  const [qaScope, setQaScope] = useState('all') // 'file' | 'folder' | 'all'
  const [question, setQuestion] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const [qaList, setQaList] = useState([])
  const [qaError, setQaError] = useState(null)
  const chatBottomRef = useRef(null)

  // Backend Health Status
  const [health, setHealth] = useState({ db: false, ollama: false })

  // Check backend health
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        setHealth({
          db: data.services?.database?.connected || false,
          ollama: data.services?.ollama?.available || false,
        })
      })
      .catch(() => setHealth({ db: false, ollama: false }))
  }, [])

  // Load folders & files for current directory
  useEffect(() => {
    let isMounted = true
    const folderId = currentFolder?.id || null
    const folderParam = folderId ? `?parentId=${folderId}` : ''
    const fileParam = folderId ? `?folderId=${folderId}` : '?folderId='

    Promise.all([
      fetch(`/api/folders${folderParam}`).then((r) => r.json()),
      fetch(`/api/files${fileParam}`).then((r) => r.json()),
    ])
      .then(([foldersData, filesData]) => {
        if (!isMounted) return
        if (foldersData.success) {
          setFolders(foldersData.folders || [])
          setBreadcrumbs(foldersData.breadcrumbs || [])
        }
        if (filesData.success) {
          setFiles(filesData.documents || [])
        }
      })
      .catch((err) => {
        if (!isMounted) return
        console.error('Failed to load directory:', err)
        setUploadError('Failed to load files from backend.')
      })

    return () => {
      isMounted = false
    }
  }, [currentFolder])

  const refreshDirectory = () => {
    const folderId = currentFolder?.id || null
    const folderParam = folderId ? `?parentId=${folderId}` : ''
    const fileParam = folderId ? `?folderId=${folderId}` : '?folderId='

    Promise.all([
      fetch(`/api/folders${folderParam}`).then((r) => r.json()),
      fetch(`/api/files${fileParam}`).then((r) => r.json()),
    ])
      .then(([foldersData, filesData]) => {
        if (foldersData.success) {
          setFolders(foldersData.folders || [])
          setBreadcrumbs(foldersData.breadcrumbs || [])
        }
        if (filesData.success) {
          setFiles(filesData.documents || [])
        }
      })
      .catch((err) => {
        console.error('Failed to refresh directory:', err)
      })
  }

  // Scroll chat to bottom on new answer
  useEffect(() => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [qaList, isAsking])

  // Folder navigation
  const handleOpenFolder = (folder) => {
    setCurrentFolder(folder)
    setSearchQuery('')
  }

  const handleNavigateBreadcrumb = (folderId) => {
    if (!folderId) {
      setCurrentFolder(null)
    } else {
      const found = breadcrumbs.find((b) => b.id === folderId)
      if (found) setCurrentFolder(found)
    }
    setSearchQuery('')
  }

  // Create new folder
  const handleCreateFolder = async (e) => {
    e.preventDefault()
    if (!newFolderName.trim()) return

    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newFolderName.trim(),
          parentId: currentFolder?.id || null,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create folder')

      setNewFolderName('')
      setShowFolderModal(false)
      refreshDirectory()
    } catch (err) {
      setUploadError(err.message)
    }
  }

  // Delete folder
  const handleDeleteFolder = async (folderId, folderName, e) => {
    e.stopPropagation()
    if (!window.confirm(`Delete folder "${folderName}" and all its contents?`)) return

    try {
      const res = await fetch(`/api/folders/${folderId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete folder')

      refreshDirectory()
    } catch (err) {
      setUploadError(err.message)
    }
  }

  // Multi-file Upload handler
  const handleFilesUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return

    setIsUploading(true)
    setUploadError(null)
    setUploadSuccess(null)

    const formData = new FormData()
    Array.from(fileList).forEach((f) => formData.append('files', f))
    if (currentFolder?.id) {
      formData.append('folderId', currentFolder.id)
    }

    try {
      const res = await fetch('/api/upload-files', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')

      setUploadSuccess(`Successfully uploaded and processed ${data.count || fileList.length} file(s)!`)
      setTimeout(() => setUploadSuccess(null), 4000)

      // Refresh directory contents
      refreshDirectory()

      // Select the first uploaded file for preview while preserving multi-document Q&A scope
      if (data.files && data.files[0]) {
        setSelectedFile(data.files[0])
      }
    } catch (err) {
      console.error('Upload error:', err)
      setUploadError(err.message || 'File upload failed.')
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Drag and Drop
  const handleDragOver = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesUpload(e.dataTransfer.files)
    }
  }

  // Select file for preview
  const handleSelectFile = (file) => {
    setSelectedFile(file)
    setPreviewTab('preview')
  }

  // Delete file
  const handleDeleteFile = async (fileId, fileName, e) => {
    e.stopPropagation()
    if (!window.confirm(`Delete file "${fileName}"?`)) return

    try {
      const res = await fetch(`/api/files/${fileId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete file')

      if (selectedFile?.id === fileId) {
        setSelectedFile(null)
        setQaScope('all')
      }
      refreshDirectory()
    } catch (err) {
      setUploadError(err.message)
    }
  }

  // Copy text to clipboard
  const handleCopyText = async (text) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy text:', err)
    }
  }

  // AI Q&A Handler
  const handleAskQuestion = async (e) => {
    if (e) e.preventDefault()
    if (!question.trim() || isAsking) return

    const userQuestion = question.trim()
    setIsAsking(true)
    setQaError(null)

    try {
      const res = await fetch('/api/ask-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userQuestion,
          scope: qaScope,
          documentId: qaScope === 'file' ? selectedFile?.id : null,
          folderId: qaScope === 'folder' ? currentFolder?.id : null,
          text: qaScope === 'file' ? selectedFile?.extracted_text : null,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to get answer from AI.')

      setQaList((prev) => [
        ...prev,
        {
          question: userQuestion,
          answer: data.answer,
          scope: data.scope || qaScope,
          scopeAutoExpanded: data.scopeAutoExpanded || false,
          sourceChunks: data.sourceChunks || [],
        },
      ])
      setQuestion('')
    } catch (err) {
      console.error('QA error:', err)
      setQaError(err.message || 'Failed to connect to AI service. Ensure Ollama is running.')
    } finally {
      setIsAsking(false)
    }
  }

  // Helper: Format file size
  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let size = bytes
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024
      i++
    }
    return `${size.toFixed(1)} ${units[i]}`
  }

  // Helper: Get icon and color class by file type
  const getFileTypeInfo = (fileType, fileName = '') => {
    const ext = fileName.split('.').pop()?.toLowerCase() || fileType
    if (fileType === 'pdf' || ext === 'pdf') {
      return { label: 'PDF', color: 'badge-pdf', icon: '📄' }
    }
    if (['docx', 'doc'].includes(ext) || fileType === 'docx') {
      return { label: 'DOCX', color: 'badge-docx', icon: '📝' }
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'].includes(ext) || fileType === 'image') {
      return { label: 'IMG', color: 'badge-img', icon: '🖼️' }
    }
    return { label: ext.toUpperCase() || 'TXT', color: 'badge-txt', icon: '📃' }
  }

  // Filter items by search query
  const filteredFolders = folders.filter((f) =>
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const filteredFiles = files.filter((f) =>
    f.file_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="hub-app">
      {/* Top Application Header */}
      <header className="hub-header">
        <div className="hub-brand">
          <div className="hub-logo">
            <span className="logo-icon">📁</span>
            <div>
              <h1>Knowledge Hub & File Explorer</h1>
              <p className="subtitle">
                Store multiple PDFs, docs, & images in folders, preview files, and chat with AI.
              </p>
            </div>
          </div>

          {/* System Services Status */}
          <div className="service-badges">
            <span className={`status-pill ${health.db ? 'online' : 'offline'}`} title="PostgreSQL / Supabase Database">
              <span className="dot" /> {health.db ? 'Database Online' : 'DB Standby'}
            </span>
            <span className={`status-pill ${health.ollama ? 'online' : 'offline'}`} title="Local Ollama AI">
              <span className="dot" /> {health.ollama ? 'Ollama (Llama 3.2)' : 'Ollama Offline'}
            </span>
          </div>
        </div>

        {/* Global Action & Search Bar */}
        <div className="hub-toolbar">
          <div className="search-bar">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search files or folders in current directory..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button type="button" className="clear-btn" onClick={() => setSearchQuery('')}>
                ×
              </button>
            )}
          </div>

          <div className="action-buttons">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowFolderModal(true)}
              title="Create new folder"
            >
              <span className="btn-icon">📁+</span> New Folder
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              title="Upload one or multiple files"
            >
              {isUploading ? (
                <span className="btn-loading">
                  <span className="spinner" /> Uploading...
                </span>
              ) : (
                <>
                  <span className="btn-icon">⬆</span> Upload Files
                </>
              )}
            </button>

            {/* Hidden multi-file input */}
            <input
              type="file"
              ref={fileInputRef}
              multiple
              onChange={(e) => handleFilesUpload(e.target.files)}
              accept=".pdf,.docx,.doc,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.svg"
              className="hidden-input"
            />
          </div>
        </div>
      </header>

      {/* Breadcrumb Navigation Bar */}
      <nav className="breadcrumbs-nav">
        <div className="breadcrumbs-trail">
          <button
            type="button"
            className={`crumb-item ${!currentFolder ? 'active' : ''}`}
            onClick={() => handleNavigateBreadcrumb(null)}
          >
            🏠 Home (Root)
          </button>

          {breadcrumbs.map((crumb) => (
            <span key={crumb.id} className="crumb-wrap">
              <span className="crumb-separator">/</span>
              <button
                type="button"
                className={`crumb-item ${currentFolder?.id === crumb.id ? 'active' : ''}`}
                onClick={() => handleNavigateBreadcrumb(crumb.id)}
              >
                📁 {crumb.name}
              </button>
            </span>
          ))}

          {currentFolder && !breadcrumbs.find((b) => b.id === currentFolder.id) && (
            <span className="crumb-wrap">
              <span className="crumb-separator">/</span>
              <span className="crumb-item active">📁 {currentFolder.name}</span>
            </span>
          )}
        </div>

        <div className="view-mode-toggle">
          <span className="items-counter">
            {filteredFolders.length} folders, {filteredFiles.length} files
          </span>
          <button
            type="button"
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid View"
          >
            ⊞
          </button>
          <button
            type="button"
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List View"
          >
            ☰
          </button>
        </div>
      </nav>

      {/* Notifications / Alerts */}
      {uploadError && (
        <div className="alert alert-error">
          <span className="alert-icon">⚠️</span>
          <span className="alert-message">{uploadError}</span>
          <button type="button" className="alert-close" onClick={() => setUploadError(null)}>
            ×
          </button>
        </div>
      )}

      {uploadSuccess && (
        <div className="alert alert-success">
          <span className="alert-icon">✓</span>
          <span className="alert-message">{uploadSuccess}</span>
          <button type="button" className="alert-close" onClick={() => setUploadSuccess(null)}>
            ×
          </button>
        </div>
      )}

      {/* Main Workspace: Explorer/Preview on Left, AI Assistant on Right */}
      <main className="hub-workspace">
        {/* LEFT / CENTER PANEL: File Explorer or Document Previewer */}
        <div className="explorer-column">
          {/* File Preview Drawer (when a file is clicked) */}
          {selectedFile ? (
            <section className="card file-preview-card">
              <div className="preview-card-header">
                <div className="preview-file-title">
                  <span className={`file-type-pill ${getFileTypeInfo(selectedFile.file_type, selectedFile.file_name).color}`}>
                    {getFileTypeInfo(selectedFile.file_type, selectedFile.file_name).label}
                  </span>
                  <h2>{selectedFile.file_name}</h2>
                  <span className="preview-meta-size">{formatFileSize(selectedFile.file_size)}</span>
                  {selectedFile.chunk_count > 0 && (
                    <span className="badge badge-chunks">{selectedFile.chunk_count} chunks</span>
                  )}
                </div>

                <div className="preview-actions">
                  <div className="tab-pills">
                    <button
                      type="button"
                      className={`tab-pill ${previewTab === 'preview' ? 'active' : ''}`}
                      onClick={() => setPreviewTab('preview')}
                    >
                      Document Preview
                    </button>
                    {selectedFile.extracted_text && (
                      <button
                        type="button"
                        className={`tab-pill ${previewTab === 'extracted' ? 'active' : ''}`}
                        onClick={() => setPreviewTab('extracted')}
                      >
                        Extracted Text
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    className={`btn btn-sm ${qaScope === 'file' ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setQaScope(qaScope === 'file' ? 'all' : 'file')}
                    title="Toggle single-file vs all-documents Q&A mode"
                  >
                    {qaScope === 'file' ? '💬 Focus: This File' : '🌐 Focus: All Files'}
                  </button>

                  <a
                    href={`/api/files/${selectedFile.id}/download`}
                    className="btn btn-sm"
                    download={selectedFile.file_name}
                    title="Download file"
                  >
                    ⬇ Download
                  </a>

                  <button
                    type="button"
                    className="btn btn-sm btn-close"
                    onClick={() => {
                      setSelectedFile(null)
                      setQaScope('all')
                    }}
                    title="Close preview and return to file explorer"
                  >
                    ✕ Close Preview
                  </button>
                </div>
              </div>

              {/* Preview Body */}
              <div className="preview-card-body">
                {previewTab === 'preview' ? (
                  <div className="preview-display-wrapper">
                    {selectedFile.file_type === 'pdf' || selectedFile.file_name.toLowerCase().endsWith('.pdf') ? (
                      <iframe
                        src={`/api/files/${selectedFile.id}/content#toolbar=1`}
                        title={selectedFile.file_name}
                        className="document-iframe"
                      />
                    ) : selectedFile.file_type === 'image' || selectedFile.mime_type?.startsWith('image/') ? (
                      <div className="image-preview-container">
                        <img
                          src={`/api/files/${selectedFile.id}/content`}
                          alt={selectedFile.file_name}
                          className="preview-image"
                        />
                      </div>
                    ) : (
                      <div className="text-doc-viewer">
                        <pre>{selectedFile.extracted_text || 'No readable text available for this file.'}</pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="extracted-text-viewer">
                    <div className="extracted-text-toolbar">
                      <span>{selectedFile.extracted_text?.length.toLocaleString() || 0} characters</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleCopyText(selectedFile.extracted_text)}
                      >
                        {isCopied ? '✓ Copied!' : 'Copy Text'}
                      </button>
                    </div>
                    <pre className="text-viewer-pre">{selectedFile.extracted_text}</pre>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          {/* Explorer Directory View (Folders & Files Grid / List) */}
          <section
            className={`card explorer-card ${isDragging ? 'dragging' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Quick Upload Drop Area */}
            <div
              className="drop-banner"
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <span className="drop-icon">📂</span>
              <div>
                <p className="drop-main-text">Drag & drop files here, or click to upload</p>
                <p className="drop-sub-text">Supports PDF, Word (.docx), Images, Markdown, Text (up to 30MB each)</p>
              </div>
            </div>

            {/* Folders Section */}
            {filteredFolders.length > 0 && (
              <div className="explorer-section">
                <h3 className="section-title">Folders ({filteredFolders.length})</h3>
                <div className={`folders-container ${viewMode}`}>
                  {filteredFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="folder-card"
                      onClick={() => handleOpenFolder(folder)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="folder-icon-wrapper">
                        <span className="folder-symbol">📁</span>
                      </div>
                      <div className="folder-info">
                        <span className="folder-name" title={folder.name}>
                          {folder.name}
                        </span>
                        <span className="folder-count">
                          {folder.file_count || 0} file{folder.file_count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="folder-delete-btn"
                        onClick={(e) => handleDeleteFolder(folder.id, folder.name, e)}
                        title="Delete folder"
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Files Section */}
            <div className="explorer-section">
              <h3 className="section-title">
                Files ({filteredFiles.length})
                {currentFolder && <span className="in-folder-tag">in {currentFolder.name}</span>}
              </h3>

              {filteredFiles.length > 0 ? (
                <div className={`files-container ${viewMode}`}>
                  {filteredFiles.map((file) => {
                    const typeInfo = getFileTypeInfo(file.file_type, file.file_name)
                    const isSelected = selectedFile?.id === file.id

                    return (
                      <div
                        key={file.id}
                        className={`file-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectFile(file)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="file-card-preview">
                          {typeInfo.label === 'IMG' ? (
                            <img
                              src={`/api/files/${file.id}/content`}
                              alt={file.file_name}
                              className="thumbnail-img"
                              loading="lazy"
                            />
                          ) : (
                            <div className={`file-badge-icon ${typeInfo.color}`}>
                              <span className="type-icon">{typeInfo.icon}</span>
                              <span className="type-label">{typeInfo.label}</span>
                            </div>
                          )}
                        </div>

                        <div className="file-card-details">
                          <h4 className="file-name" title={file.file_name}>
                            {file.file_name}
                          </h4>
                          <div className="file-meta-row">
                            <span className="meta-size">{formatFileSize(file.file_size)}</span>
                            {file.chunk_count > 0 && (
                              <span className="badge badge-chunks mini">{file.chunk_count} chunks</span>
                            )}
                          </div>
                        </div>

                        <div className="file-card-actions">
                          <button
                            type="button"
                            className="btn-icon-action"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSelectFile(file)
                            }}
                            title="Preview file"
                          >
                            👁
                          </button>
                          <a
                            href={`/api/files/${file.id}/download`}
                            className="btn-icon-action"
                            download={file.file_name}
                            onClick={(e) => e.stopPropagation()}
                            title="Download file"
                          >
                            ⬇
                          </a>
                          <button
                            type="button"
                            className="btn-icon-action delete"
                            onClick={(e) => handleDeleteFile(file.id, file.file_name, e)}
                            title="Delete file"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="empty-explorer-state">
                  <div className="empty-icon">🗂️</div>
                  <h4>No files in this folder</h4>
                  <p>Upload PDFs, Word docs, images, or create subfolders to get started.</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT PANEL: AI Q&A Assistant */}
        <div className="ai-column">
          <section className="card qa-card">
            <div className="qa-header">
              <div className="qa-title-row">
                <div className="qa-title">
                  <span className="ai-icon">✨</span>
                  <h3>AI Document Assistant</h3>
                </div>
                <span className="badge badge-ai">Ollama • llama3.2</span>
              </div>
              <p className="qa-subtitle">
                Ask questions and extract insights grounded strictly in your uploaded files.
              </p>

              {/* RAG Scope Selector */}
              <div className="scope-selector">
                <span className="scope-label">Search In:</span>
                <div className="scope-buttons">
                  <button
                    type="button"
                    className={`scope-btn ${qaScope === 'all' ? 'active' : ''}`}
                    onClick={() => setQaScope('all')}
                    title="Search across all documents in your library (recommended for multi-PDF questions)"
                  >
                    🌐 All Documents <span className="scope-badge">Multi-PDF</span>
                  </button>

                  <button
                    type="button"
                    className={`scope-btn ${qaScope === 'folder' ? 'active' : ''}`}
                    onClick={() => setQaScope('folder')}
                    disabled={!currentFolder}
                    title={currentFolder ? `Chat with all files in ${currentFolder.name}` : 'Open a folder to enable'}
                  >
                    📁 Current Folder
                    {currentFolder && <span className="scope-chip">{currentFolder.name}</span>}
                  </button>

                  <button
                    type="button"
                    className={`scope-btn ${qaScope === 'file' ? 'active' : ''}`}
                    onClick={() => setQaScope('file')}
                    disabled={!selectedFile}
                    title={selectedFile ? `Chat only with ${selectedFile.file_name}` : 'Select a file to enable single-file mode'}
                  >
                    📄 Single File
                    {selectedFile && <span className="scope-chip">{selectedFile.file_name}</span>}
                  </button>
                </div>
              </div>
            </div>

            {/* Chat Message History */}
            <div className="qa-chat-history">
              {qaList.length === 0 ? (
                <div className="qa-welcome-state">
                  <span className="welcome-robot">🤖</span>
                  <h4>How can I help with your documents?</h4>
                  <p>Choose your search scope above, then ask any question about your files.</p>

                  <div className="suggested-queries">
                    <button
                      type="button"
                      className="suggested-btn"
                      onClick={() => setQuestion('Summarize the main topics covered across these documents.')}
                    >
                      💡 Summarize the main topics
                    </button>
                    <button
                      type="button"
                      className="suggested-btn"
                      onClick={() => setQuestion('What are the key conclusions or takeaways?')}
                    >
                      💡 What are the key conclusions?
                    </button>
                  </div>
                </div>
              ) : (
                qaList.map((item, idx) => (
                  <div key={idx} className="qa-chat-entry">
                    <div className="qa-bubble user-bubble">
                      <span className="avatar">You</span>
                      <div className="bubble-content">
                        <p>{item.question}</p>
                        <span className={`bubble-scope-tag ${item.scopeAutoExpanded ? 'auto-expanded' : ''}`}>
                          {item.scopeAutoExpanded
                            ? '🌐 All Documents (Multi-PDF Expanded)'
                            : item.scope === 'file'
                            ? '📄 Single File'
                            : item.scope === 'folder'
                            ? '📁 Folder Scope'
                            : '🌐 All Documents (Multi-PDF)'}
                        </span>
                      </div>
                    </div>

                    <div className="qa-bubble ai-bubble">
                      <span className="avatar">AI</span>
                      <div className="bubble-content">
                        <div className="answer-text">{item.answer}</div>

                        {item.sourceChunks && item.sourceChunks.length > 0 && (
                          <details className="source-citations">
                            <summary>
                              🔍 {item.sourceChunks.length} reference chunk
                              {item.sourceChunks.length === 1 ? '' : 's'} cited
                            </summary>
                            <div className="citation-list">
                              {item.sourceChunks.map((chunk, cIdx) => (
                                <div key={cIdx} className="citation-card">
                                  <div className="citation-header">
                                    <span className="citation-doc">
                                      📄 {chunk.fileName || 'Document'}
                                    </span>
                                    <span className="citation-chunk">
                                      Chunk #{chunk.chunkIndex !== undefined ? chunk.chunkIndex + 1 : cIdx + 1}
                                    </span>
                                  </div>
                                  <p className="citation-body">{chunk.content}</p>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}

              {isAsking && (
                <div className="qa-bubble ai-bubble thinking">
                  <span className="avatar">AI</span>
                  <div className="bubble-content">
                    <div className="typing-indicator">
                      <span className="dot" />
                      <span className="dot" />
                      <span className="dot" />
                    </div>
                    <span className="thinking-text">Searching chunks and generating grounded response...</span>
                  </div>
                </div>
              )}

              <div ref={chatBottomRef} />
            </div>

            {qaError && (
              <div className="alert alert-error inline">
                <span className="alert-icon">⚠️</span>
                <span className="alert-message">{qaError}</span>
              </div>
            )}

            {/* Smart Multi-Document Question Hint */}
            {qaScope === 'file' &&
              /\b(both|all|across|compare|comparison|differ|difference|between|versus|vs|other|another|second|2\s+files|3\s+files)\b/i.test(
                question
              ) && (
                <div className="scope-hint-banner">
                  <span>💡 Comparing files? Switch to <strong>All Documents</strong> so AI can read all your PDFs.</span>
                  <button
                    type="button"
                    className="btn-primary-outline"
                    onClick={() => setQaScope('all')}
                  >
                    Switch to 🌐 All Documents
                  </button>
                </div>
              )}

            {/* Question Input Form */}
            <form onSubmit={handleAskQuestion} className="qa-input-form">
              <input
                type="text"
                placeholder={
                  qaScope === 'file' && selectedFile
                    ? `Ask anything about "${selectedFile.file_name}"...`
                    : qaScope === 'folder' && currentFolder
                    ? `Ask anything across folder "${currentFolder.name}"...`
                    : 'Ask across all documents in your library...'
                }
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={isAsking}
                className="qa-text-input"
              />
              <button
                type="submit"
                className="btn btn-primary qa-submit-btn"
                disabled={!question.trim() || isAsking}
              >
                {isAsking ? 'Thinking...' : 'Ask AI'}
              </button>
            </form>
          </section>
        </div>
      </main>

      {/* New Folder Modal */}
      {showFolderModal && (
        <div className="modal-backdrop" onClick={() => setShowFolderModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create New Folder</h3>
              <button type="button" className="close-btn" onClick={() => setShowFolderModal(false)}>
                ×
              </button>
            </div>
            <form onSubmit={handleCreateFolder}>
              <div className="modal-body">
                <label htmlFor="folderNameInput">Folder Name</label>
                <input
                  id="folderNameInput"
                  type="text"
                  placeholder="e.g., Financial Reports, Machine Learning"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  autoFocus
                />
                <small>
                  Location: {currentFolder ? `Inside "${currentFolder.name}"` : 'Root directory'}
                </small>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowFolderModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!newFolderName.trim()}>
                  Create Folder
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
