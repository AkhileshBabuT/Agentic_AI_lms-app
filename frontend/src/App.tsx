import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Courses from './pages/Courses';
import CoursePage from './pages/CoursePage';
import AssignmentSubmission from './pages/AssignmentSubmission';
import ProfessorAssignmentDetail from './pages/ProfessorAssignmentDetail';
import AIAgentHub from './pages/AIAgentHub';
import ChatInterface from './pages/ChatInterface';
import AgentContentViewer from './pages/AgentContentViewer';
import MaterialSourceViewer from './pages/MaterialSourceViewer';
import ProtectedRoute from './components/ProtectedRoute';
import RoleBasedDashboard from './components/RoleBasedDashboard';
import './App.css';

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Router>
          <div className="App">
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <RoleBasedDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/courses"
                element={
                  <ProtectedRoute>
                    <Courses />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/courses/:id"
                element={
                  <ProtectedRoute>
                    <CoursePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/assignments/:assignmentId"
                element={
                  <ProtectedRoute>
                    <AssignmentSubmission />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/professor/assignments/:assignmentId"
                element={
                  <ProtectedRoute>
                    <ProfessorAssignmentDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/ai-agent-hub"
                element={
                  <ProtectedRoute>
                    <AIAgentHub />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat/:sessionId"
                element={
                  <ProtectedRoute>
                    <ChatInterface />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/agent-content/:contentId"
                element={
                  <ProtectedRoute>
                    <AgentContentViewer />
                  </ProtectedRoute>
                }
              />
              <Route path="/material-source/:chunkId" element={<ProtectedRoute><MaterialSourceViewer /></ProtectedRoute>} />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </div>
        </Router>
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;
