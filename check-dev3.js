import { connect, getDB, oid } from './back/src/db.js';

async function findDev3Project() {
  try {
    await connect();
    const db = getDB();
    
    // Find dev3 project
    const project = await db.collection('projects').findOne({ name: 'dev3' });
    if (!project) {
      console.log('dev3 project not found, listing all projects:');
      const projects = await db.collection('projects').find({}).toArray();
      projects.forEach(p => console.log('- ' + p.name + ' (id: ' + p._id + ')'));
      return;
    }
    
    console.log('Found dev3 project:', JSON.stringify(project, null, 2));
    
    // Find configurations for this project
    const configs = await db.collection('configurations').find({ project_id: project._id }).toArray();
    console.log('\nConfigurations for dev3 project:');
    configs.forEach(c => {
      console.log('- ' + c.name + ' (id: ' + c._id + ')');
      console.log('  Domain: ' + c.domain);
      console.log('  Login enabled: ' + c.login_enabled);
      if (c.login_enabled) {
        console.log('  Login URL: ' + c.login_url);
        console.log('  Username: ' + c.username);
        console.log('  Password: ' + (c.password ? '[HIDDEN]' : 'Not set'));
      }
    });
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

findDev3Project();
