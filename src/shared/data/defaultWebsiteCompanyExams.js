'use strict';

const defaultWebsiteCompanyExams = [
  {
    id: "exam-1",
    title: "Infosys InfyTQ Mock Test - 2024",
    category: "Real-Time Exam Pattern Tests",
    company: "Infosys",
    level: "Advanced",
    image: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80",
    imageKey: "course-1",
    isFree: false,
    price: 249,
    originalPrice: 499,
    mrp: 499,
    questionsCount: 65,
    questionCount: 65,
    duration: "100 mins",
    timeMinutes: 100,
    isBundle: false,
    isExamPattern: true,
    examDetails: {
      examName: "Infosys InfyTQ",
      pattern: [
        { section: "Reasoning Ability", count: 20 },
        { section: "Technical Ability (DBMS & OOPs)", count: 20 },
        { section: "Coding (Python/Java)", count: 2 },
      ]
    },
    bundleDetails: null,
    status: "active",
    order: 1
  },
  {
    id: "exam-2",
    title: "TCS NQT Free Diagnostic Test",
    category: "Real-Time Exam Pattern Tests",
    company: "TCS",
    level: "Beginner",
    image: "https://images.unsplash.com/photo-1456406644174-8ddd4cd52a06?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80",
    imageKey: "course-2",
    isFree: true,
    price: 0,
    originalPrice: 0,
    mrp: 0,
    questionsCount: 30,
    questionCount: 30,
    duration: "45 mins",
    timeMinutes: 45,
    isBundle: false,
    isExamPattern: true,
    examDetails: {
      examName: "TCS NQT Foundation",
      pattern: [
        { section: "Numerical Ability", count: 10 },
        { section: "Verbal Ability", count: 10 },
        { section: "Reasoning Ability", count: 10 },
      ]
    },
    bundleDetails: null,
    status: "active",
    order: 2
  },
  {
    id: "exam-bundle-1",
    title: "Infosys - Last 3 Years Exam Pattern Bundle",
    category: "Real-Time Exam Pattern Tests",
    company: "Infosys",
    level: "Bundle",
    image: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80",
    imageKey: "course-3",
    isFree: false,
    price: 899,
    originalPrice: 1999,
    mrp: 1999,
    questionsCount: 450,
    questionCount: 450,
    duration: "12 hours",
    timeMinutes: 720,
    isBundle: true,
    isExamPattern: true,
    examDetails: null,
    bundleDetails: {
      levelsIncluded: ["2021", "2022", "2023"],
      topicsIncluded: "6 Full-Length Mock Tests",
      savings: "Save ₹1100 compared to individual test purchases"
    },
    status: "active",
    order: 3
  },
  {
    id: "exam-3",
    title: "Wipro Elite National Talent Hunt",
    category: "Real-Time Exam Pattern Tests",
    company: "Wipro",
    level: "Pro",
    image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80",
    imageKey: "course-4",
    isFree: false,
    price: 199,
    originalPrice: 399,
    mrp: 399,
    questionsCount: 80,
    questionCount: 80,
    duration: "120 mins",
    timeMinutes: 120,
    isBundle: false,
    isExamPattern: true,
    examDetails: {
      examName: "Wipro Elite NTH",
      pattern: [
        { section: "Quantitative Aptitude", count: 16 },
        { section: "Logical Reasoning", count: 14 },
        { section: "Verbal Ability", count: 22 },
        { section: "Automata Fix (Coding)", count: 2 },
      ]
    },
    bundleDetails: null,
    status: "active",
    order: 4
  },
  {
    id: "exam-4",
    title: "Accenture Cognitive & Technical Test",
    category: "Real-Time Exam Pattern Tests",
    company: "Accenture",
    level: "Intermediate",
    image: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80",
    imageKey: "course-5",
    isFree: true,
    price: 0,
    originalPrice: 0,
    mrp: 0,
    questionsCount: 90,
    questionCount: 90,
    duration: "90 mins",
    timeMinutes: 90,
    isBundle: false,
    isExamPattern: true,
    examDetails: {
      examName: "Accenture Cognitive",
      pattern: [
        { section: "English Ability", count: 17 },
        { section: "Critical Reasoning", count: 18 },
        { section: "Abstract Reasoning", count: 15 },
        { section: "Common Application & MS Office", count: 12 },
        { section: "Pseudocode", count: 18 },
        { section: "Network & Security", count: 10 }
      ]
    },
    bundleDetails: null,
    status: "active",
    order: 5
  }
];

module.exports = {
  defaultWebsiteCompanyExams
};
