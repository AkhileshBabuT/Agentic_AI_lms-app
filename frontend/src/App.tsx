import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';
import ProtectedRoute from './components/ProtectedRoute';
import RouteSkeleton from './components/RouteSkeleton';
import ChunkErrorBoundary from './components/ChunkErrorBoundary';
import AppShell from './layout/AppShell';
import './App.css';

const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const StudentDashboard = lazy(() => import('./pages/StudentDashboard'));
const ProfessorDashboard = lazy(() => import('./pages/ProfessorDashboard'));
const RootDashboard = lazy(() => import('./pages/RootDashboard'));
const CoursePage = lazy(() => import('./pages/CoursePage'));
const AssignmentSubmission = lazy(() => import('./pages/AssignmentSubmission'));
const ProfessorAssignmentDetail = lazy(() => import('./pages/ProfessorAssignmentDetail'));
const AIAgentHub = lazy(() => import('./pages/AIAgentHub'));
const ChatInterface = lazy(() => import('./pages/ChatInterface'));
const AgentContentViewer = lazy(() => import('./pages/AgentContentViewer'));
const MaterialSourceViewer = lazy(() => import('./pages/MaterialSourceViewer'));
const UIShowcase = lazy(() => import('./components/ui/UIShowcase').then(module => ({ default: module.UIShowcase })));

function Dashboard() {
  const { user } = useAuth();
  if (user?.role === 'root') return <RootDashboard />;
  if (user?.role === 'professor') return <ProfessorDashboard />;
  return <StudentDashboard />;
}

function protectedPage(page: ReactNode, withShell = true) {
  return <ProtectedRoute>{withShell ? <AppShell>{page}</AppShell> : page}</ProtectedRoute>;
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Router>
          <div className="App">
            <ChunkErrorBoundary>
              <Suspense fallback={<RouteSkeleton />}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/signup" element={<Signup />} />
                  <Route path="/dashboard" element={protectedPage(<Dashboard />)} />
                  <Route path="/courses" element={protectedPage(<Navigate to="/dashboard" replace />)} />
                  <Route path="/courses/:id" element={protectedPage(<CoursePage />)} />
                  <Route path="/assignments/:assignmentId" element={protectedPage(<AssignmentSubmission />)} />
                  <Route path="/professor/assignments/:assignmentId" element={protectedPage(<ProfessorAssignmentDetail />)} />
                  <Route path="/ai-agent-hub" element={protectedPage(<AIAgentHub />)} />
                  <Route path="/chat/:sessionId" element={protectedPage(<ChatInterface />)} />
                  <Route path="/agent-content/:contentId" element={protectedPage(<AgentContentViewer />, false)} />
                  <Route path="/material-source/:chunkId" element={protectedPage(<MaterialSourceViewer />, false)} />
                  {import.meta.env.DEV && <Route path="/ui-showcase" element={protectedPage(<UIShowcase />)} />}
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </Suspense>
            </ChunkErrorBoundary>
          </div>
        </Router>
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;
